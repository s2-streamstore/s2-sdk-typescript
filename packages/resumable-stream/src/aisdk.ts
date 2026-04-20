import type { S2Endpoints, S2EndpointsInit } from "@s2-dev/streamstore";
import {
	AppendRecord,
	FencingTokenMismatchError,
	randomToken,
	S2,
} from "@s2-dev/streamstore";
import {
	JsonToSseTransformStream,
	UI_MESSAGE_STREAM_HEADERS,
	type UIMessageChunk,
} from "ai";
import { appendFenceCommand, persistToS2 } from "./protocol.js";
import {
	claimSharedGeneration,
	replayActiveGenerationStringBodies,
} from "./shared.js";

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LINGER_DURATION = 50;
const DEFAULT_LEASE_DURATION_MS = 60 * 1000;

/**
 * Configuration for creating a resumable AI SDK chat helper.
 */
export interface ResumableChatConfig {
	/** S2 access token. */
	accessToken: string;
	/** Basin used for resumable streams. */
	basin: string;
	/** Optional endpoint overrides, for example when using `s2-lite`. */
	endpoints?: S2Endpoints | S2EndpointsInit;
	/** Maximum number of chunks to append in one batch. Defaults to `10`. */
	batchSize?: number;
	/** Maximum time to buffer a batch before flushing, in milliseconds. Defaults to `50`. */
	lingerDuration?: number;
	/** Whether each generation uses its own stream or reuses one stream name sequentially. */
	streamReuse?: "single-use" | "shared";
	/**
	 * Only applies to `streamReuse: "shared"`.
	 *
	 * If a previous generation crashed or was aborted without writing a
	 * terminal fence, its non-terminal fence still "owns" the stream. After
	 * `leaseDurationMs` have elapsed since that fence was written (by the
	 * coordinator's clock), the next claim takes it over. Set this longer
	 * than your longest expected generation. Defaults to 1 minute.
	 *
	 * Timestamps on fence records come from the coordinator (`Date.now()`),
	 * which relies on S2's default `client-prefer` timestamping mode.
	 */
	leaseDurationMs?: number;
}

/**
 * Options for `makeResumable`.
 */
export interface MakeResumableOptions {
	/**
	 * Keeps the background S2 persistence alive after the response returns.
	 * On platforms like Vercel / Cloudflare, pass the platform-provided
	 * `waitUntil` (e.g. `after` from `next/server`).
	 */
	waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Server-side helpers for writing and replaying resumable AI SDK streams.
 */
export interface ResumableChat {
	/**
	 * Starts making a `UIMessageChunk` stream resumable in S2 and returns the
	 * stream as an SSE `Response` body. The underlying source is teed — one
	 * branch streams to the client, the other is persisted to S2.
	 */
	makeResumable(
		streamName: string,
		source: AsyncIterable<UIMessageChunk>,
		options?: MakeResumableOptions,
	): Promise<Response>;
	/**
	 * Replays the currently active generation as an SSE `UIMessageChunk` stream.
	 * Returns `204` when there is no active generation to replay.
	 */
	replay(streamName: string): Promise<Response>;
}

function makeErrorChunkRecord(err: unknown): AppendRecord {
	const errorText =
		err instanceof Error && err.message
			? err.message
			: "The generation ended before the stream completed.";
	return AppendRecord.string({
		body: JSON.stringify({
			type: "error",
			errorText,
		} satisfies UIMessageChunk),
	});
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

/**
 * Creates server-side helpers for making AI SDK streams resumable in S2.
 */
export function createResumableChat(
	config: ResumableChatConfig,
): ResumableChat {
	const s2 = new S2({
		accessToken: config.accessToken,
		endpoints: config.endpoints,
	});
	const basin = config.basin;
	const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
	const lingerDuration = config.lingerDuration ?? DEFAULT_LINGER_DURATION;
	const streamReuse = config.streamReuse ?? "single-use";
	const leaseDurationMs = config.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;

	const makeResumable = async (
		streamName: string,
		source: AsyncIterable<UIMessageChunk>,
		options?: MakeResumableOptions,
	): Promise<Response> => {
		const fencingToken = `session-${randomToken(8)}`;
		let matchSeqNumStart = 1;

		try {
			if (streamReuse === "shared") {
				const claim = await claimSharedGeneration({
					s2,
					basin,
					stream: streamName,
					fencingToken,
					leaseDurationMs,
				});
				if (!claim) {
					return new Response("Stream already in use", { status: 409 });
				}
				matchSeqNumStart = claim.matchSeqNumStart;
			} else {
				const ack = await appendFenceCommand(
					s2,
					basin,
					streamName,
					"",
					fencingToken,
				);
				matchSeqNumStart = ack.end.seqNum;
			}
		} catch (err) {
			if (err instanceof FencingTokenMismatchError) {
				return new Response("Stream already in use", { status: 409 });
			}
			throw err;
		}

		const [toClient, toPersist] = asyncIterableToReadableStream(source).tee();

		const persistPromise = persistToS2({
			s2,
			basin,
			stream: streamName,
			source: readableToAsyncIterable(toPersist),
			fencingToken,
			batchSize,
			lingerDuration,
			matchSeqNumStart,
			toRecord: (chunk) => AppendRecord.string({ body: JSON.stringify(chunk) }),
			finalRecords: (sourceError) =>
				sourceError !== undefined
					? [
							makeErrorChunkRecord(sourceError),
							AppendRecord.fence(`error-${randomToken(4)}`),
						]
					: [AppendRecord.fence(`end-${randomToken(4)}`)],
		});

		if (options?.waitUntil) {
			options.waitUntil(persistPromise);
		} else {
			persistPromise.catch((err) => {
				console.error("[resumable-stream] Background persist failed:", err);
			});
		}

		return new Response(
			toClient
				.pipeThrough(new JsonToSseTransformStream())
				.pipeThrough(new TextEncoderStream()),
			{ headers: UI_MESSAGE_STREAM_HEADERS },
		);
	};

	return {
		makeResumable,

		async replay(streamName: string): Promise<Response> {
			const iterator = replayActiveGenerationStringBodies({
				s2,
				basin,
				stream: streamName,
			})[Symbol.asyncIterator]();
			const first = await iterator.next();
			if (first.done) {
				return new Response(null, {
					status: 204,
					headers: { "Cache-Control": "no-store" },
				});
			}

			const encoder = new TextEncoder();
			let pending: string | undefined = first.value;
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						if (pending !== undefined) {
							const value = pending;
							pending = undefined;
							controller.enqueue(encoder.encode(`data: ${value}\n\n`));
							return;
						}
						const next = await iterator.next();
						if (next.done) {
							controller.enqueue(encoder.encode("data: [DONE]\n\n"));
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

			return new Response(body, { headers: UI_MESSAGE_STREAM_HEADERS });
		},
	};
}
