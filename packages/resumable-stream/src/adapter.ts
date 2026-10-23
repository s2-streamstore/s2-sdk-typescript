import {
	AppendInput,
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
	dataRecords,
	isFenceRecord,
	persistToS2,
} from "./protocol.js";
import {
	claimSessionGeneration,
	claimSharedGeneration,
	readLastFence,
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
const STOP_POLL_MS = 1000;

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
	 *   Older generations are trimmed on each claim, and replay yields only the active generation.
	 * - `session`: generations append to one durable session log. Replay tails the stream,
	 *   surfacing chunks from every generation as they land.
	 */
	mode?: ResumableChatMode;
	/**
	 * Applies to `shared` and `session`. If an active generation hasn't written
	 * a record for this many milliseconds, the next claim takes it over.
	 * Defaults to 5000.
	 */
	leaseDurationMs?: number;
	/**
	 * Maps an upstream error to the message surfaced to the client when a generation fails mid-stream.
	 * Defaults to returning "An error occurred.".
	 */
	onError?: (error: unknown) => string;
	/** Called when persisting a generation fails. Defaults to `console.error`. */
	onPersistError?: (error: unknown) => void;
}

/**
 * Chunks to persist. A function is called once the stream is claimed, with a
 * signal that aborts when the generation is stopped or taken over; pass it to
 * the model call (e.g. `streamText({ abortSignal })`).
 */
export type ResumableSource<T> =
	| AsyncIterable<T>
	| ((signal: AbortSignal) => AsyncIterable<T> | Promise<AsyncIterable<T>>);

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
	/**
	 * Identifies the request starting the generation, such as the last user
	 * message id. A retry with the same id while that generation is active
	 * streams it instead of returning 409.
	 */
	requestId?: string;
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
		source: ResumableSource<T>,
		options?: MakeResumableOptions,
	): Promise<Response>;
	/**
	 * Streams stored chunks as SSE. Returns 204 if there is no active generation,
	 * unless session replay is called with `{ live: true }`.
	 */
	replay(streamName: string, options?: ReplayOptions): Promise<Response>;
	/**
	 * Ends the active generation: readers receive the adapter's stop chunk and
	 * finish, and the writer stops at its next append. Returns false if no
	 * generation is active.
	 */
	stop(streamName: string): Promise<boolean>;
}

/** Adapter contract for plugging a chunk shape into the shared chat implementation. */
export interface ChatAdapter<T> {
	/** Synthesize an error chunk to surface upstream failures to the client. */
	makeErrorChunk(err: unknown, onError?: (err: unknown) => string): T;
	/** Chunk appended when a generation is stopped. */
	makeStopChunk?: () => T;
	/** Prepare a chunk before storage. */
	prepareForStorage?: (chunk: T) => T;
	/** SSE response headers. */
	responseHeaders: Readonly<Record<string, string>>;
	/**
	 * Adds an `event:` line to SSE frames when the format needs one.
	 */
	formatSseFrame?: (storedBody: string) => SseFrame;
}

async function* resolveSource<T>(
	source: ResumableSource<T>,
	signal: AbortSignal,
): AsyncIterable<T> {
	yield* typeof source === "function" ? await source(signal) : source;
}

/**
 * Every writer gets a unique token so a stale writer can never append into a
 * generation that replaced it; retries of one request share the prefix, which
 * is what rejoin matches.
 */
async function requestFencingTokenPrefix(requestId: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(requestId),
	);
	return `req-${btoa(String.fromCharCode(...new Uint8Array(digest))).slice(0, 24)}-`;
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
	const onPersistError =
		config.onPersistError ??
		((err: unknown) =>
			console.error("[resumable-stream] Persist failed:", err));

	const isShared = mode === "shared" || mode === "session";
	const isSession = mode === "session";
	// Once a stop or another writer fences the stream, other failures (such as
	// the source throwing on abort) are consequences of it.
	const isExpectedTakeover = (err: unknown): boolean =>
		err instanceof FencingTokenMismatchError ||
		(err instanceof AggregateError &&
			err.errors.some((error) => error instanceof FencingTokenMismatchError));
	const toBody = (chunk: T): string =>
		JSON.stringify(
			adapter.prepareForStorage ? adapter.prepareForStorage(chunk) : chunk,
		);

	return {
		async makeResumable(
			streamName: string,
			source: ResumableSource<T>,
			options?: MakeResumableOptions,
		): Promise<Response> {
			const requestPrefix = options?.requestId
				? await requestFencingTokenPrefix(options.requestId)
				: undefined;
			// Fencing tokens are limited to 36 bytes: the prefix is 29.
			const fencingToken = requestPrefix
				? `${requestPrefix}${randomToken(3)}`
				: `session-${randomToken(8)}`;
			let matchSeqNumStart = 1;
			const handle = s2.basin(basin).stream(streamName);
			const delivery = options?.delivery ?? "response";

			const inUse = async (): Promise<Response> => {
				if (!requestPrefix) return streamInUseResponse();
				const rejoinHandle = s2.basin(basin).stream(streamName);
				const rejoined = await replayResponse(
					closeHandleWhenDone(
						rejoinHandle,
						replayActiveGenerationStringRecords(rejoinHandle, 0, requestPrefix),
					),
					adapter.responseHeaders,
					adapter.formatSseFrame,
				);
				return rejoined.status === 204 ? streamInUseResponse() : rejoined;
			};

			let claimed = false;
			try {
				if (isSession) {
					const claim = await claimSessionGeneration({
						stream: handle,
						fencingToken,
						leaseDurationMs,
					});
					if (!claim) {
						return inUse();
					}
					matchSeqNumStart = claim.matchSeqNumStart;
				} else if (isShared) {
					const claim = await claimSharedGeneration({
						stream: handle,
						fencingToken,
						leaseDurationMs,
					});
					if (!claim) {
						return inUse();
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
					return inUse();
				}
				throw err;
			} finally {
				if (!claimed) await handle.close();
			}

			const abort = new AbortController();
			let lastWrite = Date.now();
			let finishing = false;
			// Records past our own durable appends were written by a stop or a
			// takeover, which appends a fence; the watcher reads only those.
			let from = matchSeqNumStart;
			const watchForStop = async () => {
				const watchHandle = s2.basin(basin).stream(streamName);
				try {
					while (!finishing && !abort.signal.aborted) {
						await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
						if (finishing || Date.now() - lastWrite < STOP_POLL_MS) continue;
						const batch = await watchHandle
							.read(
								{ start: { from: { seqNum: from } }, stop: { waitSecs: 0 } },
								{ as: "string" },
							)
							.catch(() => undefined);
						const records = batch?.records ?? [];
						if (records.length === 0) continue;
						from = records.at(-1)!.seqNum + 1;
						if (records.some(isFenceRecord) && !finishing) abort.abort();
					}
				} finally {
					await watchHandle.close();
				}
			};
			if (typeof source === "function") void watchForStop();

			const persisted = persistToS2({
				s2,
				basin,
				stream: streamName,
				source: resolveSource(source, abort.signal),
				abortSource: () => abort.abort(),
				onAppended: (seqNum) => {
					from = Math.max(from, seqNum + 1);
				},
				fencingToken,
				batchSize,
				lingerDuration,
				matchSeqNumStart,
				toRecords: (chunk) => {
					lastWrite = Date.now();
					return dataRecords(toBody(chunk));
				},
				finalRecords: (sourceError) => {
					finishing = true;
					return sourceError === undefined
						? [AppendRecord.fence(`end-${randomToken(4)}`)]
						: [
								...dataRecords(JSON.stringify(errorChunk(sourceError))),
								AppendRecord.fence(`error-${randomToken(4)}`),
							];
				},
			})
				.catch((err) => {
					if (isExpectedTakeover(err)) {
						abort.abort();
						return;
					}
					onPersistError(err);
				})
				.finally(() => {
					finishing = true;
				});

			if (options?.waitUntil) {
				options.waitUntil(persisted);
			} else if (delivery === "replay") {
				await persisted;
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

		async stop(streamName: string): Promise<boolean> {
			const handle = s2.basin(basin).stream(streamName);
			try {
				const { fence } = await readLastFence(handle);
				if (!fence?.active) return false;
				const stopChunk = adapter.makeStopChunk?.();
				await handle.append(
					AppendInput.create(
						[
							...(stopChunk === undefined
								? []
								: dataRecords(toBody(stopChunk))),
							AppendRecord.fence(`end-${randomToken(4)}`),
						],
						{ fencingToken: fence.body },
					),
				);
				return true;
			} catch (err) {
				if (err instanceof FencingTokenMismatchError) return false;
				throw err;
			} finally {
				await handle.close();
			}
		},
	};
}
