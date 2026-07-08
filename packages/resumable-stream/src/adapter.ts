import {
	AppendRecord,
	FencingTokenMismatchError,
	randomToken,
	S2,
	type S2Endpoints,
	type S2EndpointsInit,
	type S2Stream,
	SeqNumMismatchError,
} from "@s2-dev/streamstore";
import {
	appendFenceCommand,
	createTerminalRecords,
	persistToS2,
} from "./protocol.js";
import {
	claimSessionGeneration,
	claimSharedGeneration,
	readSessionReplayState,
	replayActiveGenerationStringRecords,
	replaySessionStringRecords,
	type SseFrame,
	type TailedStringRecord,
	tailAsSse,
	tailGenerationStringRecords,
	tailStringRecords,
} from "./shared.js";

export type { SseFrame } from "./shared.js";

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LINGER_DURATION = 50;
const DEFAULT_LEASE_DURATION_MS = 5 * 1000;

export const DEFAULT_ERROR_TEXT = "An error occurred.";
const STREAM_IN_USE_TEXT = "Stream already in use";

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
	 * Only applies to `shared`. If an active generation hasn't written a record
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
	 * Keeps S2 persistence alive after the response returns.
	 * Pass the platform-provided `waitUntil` (Vercel/Cloudflare).
	 */
	waitUntil?: (promise: Promise<unknown>) => void;
	/**
	 * Which path delivers chunks to the client.
	 * - `response` streams S2 records on the request that starts generation.
	 * - `replay` writes chunks to S2 and returns 202; another route sends them.
	 *
	 * Use `replay` when the start request should not stream the response.
	 *
	 * @default "response"
	 */
	delivery?: "response" | "replay";
}

/** Options for `replay`. */
export interface ReplayOptions {
	/**
	 * Sequence number to start reading from. Only meaningful for
	 * `mode: "session"`, where replay tails a long-lived log.
	 */
	fromSeqNum?: number;
	/**
	 * Only applies to `mode: "session"`. Keep the response open at the tail so
	 * future records from later generations are delivered to other tabs.
	 */
	live?: boolean;
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
	/**
	 * Streams stored chunks as SSE. Returns 204 if there is no active generation,
	 * unless session replay is called with `{ live: true }`.
	 */
	replay(streamName: string, options?: ReplayOptions): Promise<Response>;
}

/** Adapter contract for plugging a chunk shape into the shared chat implementation. */
export interface ChatAdapter<T> {
	/** Synthesize an error chunk to surface upstream failures to the client. */
	makeErrorChunk(err: unknown, onError?: (err: unknown) => string): T;
	/** Prepare a chunk before storage. */
	prepareForStorage?: (chunk: T) => T;
	/** SSE response headers. */
	responseHeaders: Readonly<Record<string, string>>;
	/**
	 * Adds an `event:` line to SSE frames when the format needs one.
	 */
	formatSseFrame?: (storedBody: string) => SseFrame;
}

function streamInUseResponse(): Response {
	return new Response(STREAM_IN_USE_TEXT, { status: 409 });
}

/**
 * Closes the stream handle (releasing its HTTP/2 session in Node) once the
 * records have been fully consumed, errored, or cancelled.
 */
async function* closeHandleWhenDone(
	handle: S2Stream,
	source: AsyncIterable<TailedStringRecord>,
): AsyncIterable<TailedStringRecord> {
	try {
		yield* source;
	} finally {
		await handle.close();
	}
}

async function replayResponse(
	source: AsyncIterable<TailedStringRecord>,
	headers: Readonly<Record<string, string>>,
	formatter?: (body: string) => SseFrame,
): Promise<Response> {
	const iterator = source[Symbol.asyncIterator]();
	const first = await iterator.next();
	if (first.done) {
		return new Response(null, {
			status: 204,
			headers: { "Cache-Control": "no-store" },
		});
	}

	return tailAsSse(
		(async function* () {
			try {
				yield first.value;
				while (true) {
					const next = await iterator.next();
					if (next.done) return;
					yield next.value;
				}
			} finally {
				// Propagate early termination so the source's cleanup runs.
				await iterator.return?.();
			}
		})(),
		headers,
		formatter,
	);
}

export function createChat<T>(
	config: ResumableChatConfig,
	adapter: ChatAdapter<T>,
	s2 = new S2({
		accessToken: config.accessToken,
		endpoints: config.endpoints,
	}),
): Chat<T> {
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
	const isExpectedTakeover = (err: unknown): boolean =>
		isShared &&
		(err instanceof FencingTokenMismatchError ||
			(err instanceof AggregateError &&
				err.errors.length > 0 &&
				err.errors.every(
					(error) => error instanceof FencingTokenMismatchError,
				)));

	return {
		async makeResumable(
			streamName: string,
			source: AsyncIterable<T>,
			options?: MakeResumableOptions,
		): Promise<Response> {
			const fencingToken = `session-${randomToken(8)}`;
			let matchSeqNumStart = 1;
			const handle = s2.basin(basin).stream(streamName);
			const delivery = options?.delivery ?? "response";

			let claimed = false;
			try {
				if (isSession) {
					const claim = await claimSessionGeneration({
						stream: handle,
						fencingToken,
					});
					if (!claim) {
						return streamInUseResponse();
					}
					matchSeqNumStart = claim.matchSeqNumStart;
				} else if (isShared) {
					const claim = await claimSharedGeneration({
						stream: handle,
						fencingToken,
						leaseDurationMs,
					});
					if (!claim) {
						return streamInUseResponse();
					}
					matchSeqNumStart = claim.matchSeqNumStart;
				} else {
					// Single-use: matchSeqNum=0 only succeeds against an empty stream.
					const ack = await appendFenceCommand(handle, "", fencingToken, {
						matchSeqNum: 0,
					});
					matchSeqNumStart = ack.end.seqNum;
				}
				claimed = true;
			} catch (err) {
				if (
					err instanceof FencingTokenMismatchError ||
					err instanceof SeqNumMismatchError
				) {
					return streamInUseResponse();
				}
				throw err;
			} finally {
				if (!claimed) await handle.close();
			}

			const persistPromise = persistToS2({
				s2,
				basin,
				stream: streamName,
				source,
				fencingToken,
				batchSize,
				lingerDuration,
				matchSeqNumStart,
				toRecord: (chunk) =>
					AppendRecord.string({
						body: JSON.stringify(
							adapter.prepareForStorage
								? adapter.prepareForStorage(chunk)
								: chunk,
						),
					}),
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
			const handledPersistPromise = persistPromise.catch((err) => {
				if (isExpectedTakeover(err)) return;
				throw err;
			});

			if (options?.waitUntil) {
				options.waitUntil(handledPersistPromise);
			} else if (delivery === "replay") {
				await handledPersistPromise.catch((err) => {
					console.error("[resumable-stream] Persist failed:", err);
				});
			} else {
				handledPersistPromise.catch((err) => {
					console.error("[resumable-stream] Background persist failed:", err);
				});
			}

			if (delivery === "replay") {
				await handle.close();
				return new Response(null, {
					status: 202,
					headers: { "Cache-Control": "no-store" },
				});
			}

			return tailAsSse(
				closeHandleWhenDone(
					handle,
					tailGenerationStringRecords(handle, matchSeqNumStart),
				),
				adapter.responseHeaders,
				adapter.formatSseFrame,
			);
		},

		async replay(
			streamName: string,
			options?: ReplayOptions,
		): Promise<Response> {
			const handle = s2.basin(basin).stream(streamName);

			if (isSession) {
				if (options?.live) {
					return tailAsSse(
						closeHandleWhenDone(
							handle,
							tailStringRecords(handle, options.fromSeqNum),
						),
						adapter.responseHeaders,
						adapter.formatSseFrame,
					);
				}
				const state = await readSessionReplayState(handle).catch(
					async (err) => {
						await handle.close();
						throw err;
					},
				);
				const records = closeHandleWhenDone(
					handle,
					replaySessionStringRecords(handle, options?.fromSeqNum, state),
				);
				if (state.hasActiveGeneration) {
					return tailAsSse(
						records,
						adapter.responseHeaders,
						adapter.formatSseFrame,
					);
				}
				return replayResponse(
					records,
					adapter.responseHeaders,
					adapter.formatSseFrame,
				);
			}

			return replayResponse(
				closeHandleWhenDone(
					handle,
					replayActiveGenerationStringRecords(handle, options?.fromSeqNum),
				),
				adapter.responseHeaders,
				adapter.formatSseFrame,
			);
		},
	};
}
