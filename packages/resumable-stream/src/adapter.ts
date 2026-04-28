import {
	AppendRecord,
	FencingTokenMismatchError,
	randomToken,
	S2,
	type S2Endpoints,
	type S2EndpointsInit,
	SeqNumMismatchError,
} from "@s2-dev/streamstore";
import {
	appendFenceCommand,
	createTerminalRecords,
	persistToS2,
} from "./protocol.js";
import {
	claimSharedGeneration,
	replayActiveGenerationStringBodies,
	tailStringRecords,
} from "./shared.js";

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LINGER_DURATION = 50;
const DEFAULT_LEASE_DURATION_MS = 5 * 1000;

export const DEFAULT_ERROR_TEXT = "An error occurred.";

export type ResumableChatMode = "single-use" | "shared" | "session";

/** Configuration shared by all resumable chat adapters. */
export interface ResumableChatConfig {
	/** S2 access token. */
	accessToken: string;
	/** Basin used for resumable streams. */
	basin: string;
	/** Optional endpoint overrides, for example when using `s2-lite`. */
	endpoints?: S2Endpoints | S2EndpointsInit;
	/** Number of chunks to batch together when appending to S2. Defaults to 10. */
	batchSize?: number;
	/** Maximum time to wait before flushing a batch, in milliseconds. Defaults to 50. */
	lingerDuration?: number;
	/**
	 * How to map generations to S2 streams. Defaults to `single-use`.
	 * - `single-use`: each generation gets a dedicated stream.
	 * - `shared`: generations reuse one stream; later writers take over via lease-based fencing.
	 *   The stream is trimmed on each claim, so replay yields only the active generation.
	 * - `session`: generations append to one durable session log. Replay tails the stream,
	 *   surfacing chunks from every generation as they land.
	 */
	mode?: ResumableChatMode;
	/**
	 * Only applies to `shared` / `session`. If an active generation hasn't written a record
	 * for this many milliseconds, the next claim takes it over. Defaults to 5000.
	 */
	leaseDurationMs?: number;
	/**
	 * Maps an upstream error to the message surfaced to the client when a generation fails mid-stream.
	 * Defaults to returning "An error occurred.".
	 */
	onError?: (error: unknown) => string;
}

/** Options for `makeResumable`. */
export interface MakeResumableOptions {
	/**
	 * Keeps background S2 persistence alive after the response returns.
	 * Pass the platform-provided `waitUntil` (Vercel/Cloudflare).
	 */
	waitUntil?: (promise: Promise<unknown>) => void;
	/**
	 * How to respond to the request that starts generation.
	 * - `stream` returns the live SSE chunks on the request itself.
	 * - `background` persists chunks to S2 and returns 202 immediately.
	 *
	 * `background` is intended for `session` mode, where a separate replay
	 * subscription is the source of truth for client delivery.
	 *
	 * @default "stream"
	 */
	responseMode?: "stream" | "background";
}

/** Options for `replay`. */
export interface ReplayOptions {
	/**
	 * Sequence number to start reading from. Only meaningful for
	 * `mode: "session"`, where replay tails a long-lived log.
	 */
	fromSeqNum?: number;
}

/** Server-side helpers for writing and replaying resumable chat streams. */
export interface Chat<T> {
	/**
	 * Persists `source` to S2 and returns the live SSE response for the client.
	 * Returns 409 if the stream is already in use.
	 */
	makeResumable(
		streamName: string,
		source: AsyncIterable<T>,
		options?: MakeResumableOptions,
	): Promise<Response>;
	/** Replays the active generation as SSE. Returns 204 if there is none. */
	replay(streamName: string, options?: ReplayOptions): Promise<Response>;
}

/** Adapter contract for plugging a chunk shape into the shared chat implementation. */
export interface ChatAdapter<T> {
	/** Synthesize an error chunk to surface upstream failures to the client. */
	makeErrorChunk(err: unknown, onError?: (err: unknown) => string): T;
	/** SSE response headers. */
	responseHeaders: Readonly<Record<string, string>>;
}

async function* readableToAsyncIterable<T>(
	rs: ReadableStream<T>,
): AsyncIterable<T> {
	const reader = rs.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

function asyncIterableToReadableStream<T>(
	source: AsyncIterable<T>,
): ReadableStream<T> {
	let iterator: AsyncIterator<T> | undefined;
	return new ReadableStream<T>({
		async pull(controller) {
			if (!iterator) iterator = source[Symbol.asyncIterator]();
			try {
				const { done, value } = await iterator.next();
				if (done) {
					controller.close();
					return;
				}
				controller.enqueue(value);
			} catch (err) {
				controller.error(err);
				await iterator?.return?.().catch(() => {});
			}
		},
		async cancel() {
			await iterator?.return?.().catch(() => {});
		},
	});
}

function sseResponseFromStrings(
	source: AsyncIterable<string>,
	headers: Readonly<Record<string, string>>,
): Response {
	const iterator = source[Symbol.asyncIterator]();
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await iterator.next();
				if (next.done) {
					controller.close();
					return;
				}
				controller.enqueue(encoder.encode(`data: ${next.value}\n\n`));
			} catch (err) {
				controller.error(err);
				await iterator.return?.();
			}
		},
		async cancel() {
			await iterator.return?.();
		},
	});
	return new Response(body, { headers });
}

function sseResponseFromTailedStrings(
	source: AsyncIterable<{ body: string; nextSeqNum: number }>,
	headers: Readonly<Record<string, string>>,
): Response {
	const iterator = source[Symbol.asyncIterator]();
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await iterator.next();
				if (next.done) {
					controller.close();
					return;
				}
				controller.enqueue(
					encoder.encode(
						`id: ${next.value.nextSeqNum}\ndata: ${next.value.body}\n\n`,
					),
				);
			} catch (err) {
				controller.error(err);
				await iterator.return?.();
			}
		},
		async cancel() {
			await iterator.return?.();
		},
	});
	return new Response(body, { headers });
}

/**
 * Generic implementation behind each resumable chat adapter. Wire format:
 * one JSON-encoded chunk per SSE `data:` frame; end-of-stream signaled by
 * connection close.
 */
export function createChat<T>(
	config: ResumableChatConfig,
	adapter: ChatAdapter<T>,
): Chat<T> {
	const s2 = new S2({
		accessToken: config.accessToken,
		endpoints: config.endpoints,
	});
	const basin = config.basin;
	const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
	const lingerDuration = config.lingerDuration ?? DEFAULT_LINGER_DURATION;
	const mode = config.mode ?? "single-use";
	const leaseDurationMs = config.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
	const errorChunk = (err: unknown): T =>
		adapter.makeErrorChunk(err, config.onError);

	const isShared = mode === "shared" || mode === "session";
	const isSession = mode === "session";
	const trimOnTerminalFence = mode === "single-use";

	return {
		async makeResumable(
			streamName: string,
			source: AsyncIterable<T>,
			options?: MakeResumableOptions,
		): Promise<Response> {
			const fencingToken = `session-${randomToken(8)}`;
			let matchSeqNumStart = 1;
			const handle = s2.basin(basin).stream(streamName);
			const responseMode = options?.responseMode ?? "stream";

			try {
				if (isShared) {
					const claim = await claimSharedGeneration({
						stream: handle,
						fencingToken,
						leaseDurationMs,
						trim: !isSession,
					});
					if (!claim) {
						return new Response("Stream already in use", { status: 409 });
					}
					matchSeqNumStart = claim.matchSeqNumStart;
				} else {
					// Single-use: matchSeqNum=0 only succeeds against an empty stream.
					const ack = await appendFenceCommand(handle, "", fencingToken, {
						matchSeqNum: 0,
					});
					matchSeqNumStart = ack.end.seqNum;
				}
			} catch (err) {
				if (
					err instanceof FencingTokenMismatchError ||
					err instanceof SeqNumMismatchError
				) {
					return new Response("Stream already in use", { status: 409 });
				}
				throw err;
			}

			let toClient: ReadableStream<T> | undefined;
			let persistSource: AsyncIterable<T>;
			if (responseMode === "background") {
				persistSource = source;
			} else {
				const [clientStream, persistStream] =
					asyncIterableToReadableStream(source).tee();
				toClient = clientStream;
				persistSource = readableToAsyncIterable(persistStream);
			}

			const persistPromise = persistToS2({
				s2,
				basin,
				stream: streamName,
				source: persistSource,
				fencingToken,
				batchSize,
				lingerDuration,
				matchSeqNumStart,
				toRecord: (chunk) =>
					AppendRecord.string({ body: JSON.stringify(chunk) }),
				finalRecords: (sourceError) => {
					if (sourceError === undefined) {
						return createTerminalRecords({
							terminalFenceToken: `end-${randomToken(4)}`,
							trim: trimOnTerminalFence,
						});
					}
					return createTerminalRecords({
						errorRecord: AppendRecord.string({
							body: JSON.stringify(errorChunk(sourceError)),
						}),
						terminalFenceToken: `error-${randomToken(4)}`,
						trim: trimOnTerminalFence,
					});
				},
			});

			if (options?.waitUntil) {
				options.waitUntil(persistPromise);
			} else {
				persistPromise.catch((err) => {
					console.error("[resumable-stream] Background persist failed:", err);
				});
			}

			if (responseMode === "background") {
				return new Response(null, {
					status: 202,
					headers: { "Cache-Control": "no-store" },
				});
			}

			const clientStrings = (async function* () {
				try {
					for await (const chunk of readableToAsyncIterable(toClient!)) {
						yield JSON.stringify(chunk);
					}
				} catch (err) {
					yield JSON.stringify(errorChunk(err));
				}
			})();

			return sseResponseFromStrings(clientStrings, adapter.responseHeaders);
		},

		async replay(
			streamName: string,
			options?: ReplayOptions,
		): Promise<Response> {
			const handle = s2.basin(basin).stream(streamName);

			if (isSession) {
				return sseResponseFromTailedStrings(
					tailStringRecords(handle, options?.fromSeqNum),
					adapter.responseHeaders,
				);
			}

			const iterator =
				replayActiveGenerationStringBodies(handle)[Symbol.asyncIterator]();
			const first = await iterator.next();
			if (first.done) {
				return new Response(null, {
					status: 204,
					headers: { "Cache-Control": "no-store" },
				});
			}

			const replayWithFirst = (async function* () {
				yield first.value;
				while (true) {
					const next = await iterator.next();
					if (next.done) return;
					yield next.value;
				}
			})();
			return sseResponseFromStrings(replayWithFirst, adapter.responseHeaders);
		},
	};
}
