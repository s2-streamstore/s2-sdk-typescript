import type { S2Endpoints, S2EndpointsInit } from "@s2-dev/streamstore";
import {
	AppendRecord,
	FencingTokenMismatchError,
	randomToken,
	S2,
} from "@s2-dev/streamstore";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { appendFenceCommand, persistToS2 } from "./protocol.js";
import {
	claimSharedGeneration,
	replayActiveGenerationStringBodies,
	replayGenerationStringBodiesFromSeqNum,
} from "./shared.js";

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LINGER_DURATION = 50;

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
}

/**
 * Options for `makeResumable`.
 */
export interface MakeResumableOptions {
	/** Runs the S2 write in the background instead of awaiting it inline. */
	waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Server-side helpers for writing and replaying resumable AI SDK streams.
 */
export interface ResumableChat {
	/**
	 * Starts making a `UIMessageChunk` stream resumable in S2.
	 * The response body contains `{ stream, fromSeqNum }`.
	 */
	makeResumable(
		streamName: string,
		source: AsyncIterable<UIMessageChunk>,
		options?: MakeResumableOptions,
	): Promise<Response>;
	/**
	 * Replays a resumable stream as NDJSON.
	 * Returns `204` when there is no active generation to replay.
	 */
	replay(streamName: string, fromSeqNum?: number): Promise<Response>;
}

/**
 * Configuration for `createS2Transport`.
 */
export interface S2TransportConfig {
	/** Chat POST endpoint. */
	api: string;
	/** Optional reconnect endpoint. Defaults to `${api}/stream`. */
	reconnectApi?: string;
	/** Default headers sent on both POST and reconnect requests. */
	headers?: HeadersInit;
	/** Optional fetch implementation override. */
	fetchClient?: typeof fetch;
}

function flattenHeaders(h?: HeadersInit): Record<string, string> {
	if (!h) return {};
	if (h instanceof Headers)
		return Object.fromEntries(h as unknown as Iterable<[string, string]>);
	if (Array.isArray(h)) return Object.fromEntries(h);
	return { ...h };
}

function buildReconnectEndpoint(
	api: string,
	reconnectApi: string | undefined,
	chatId: string,
	fromSeqNum?: number,
): string {
	const base = reconnectApi ?? defaultReconnectApi(api);
	const params = new URLSearchParams({ id: chatId });
	if (fromSeqNum !== undefined) {
		params.set("from", String(fromSeqNum));
	}
	const separator = base.includes("?") ? "&" : "?";
	return `${base}${separator}${params.toString()}`;
}

function defaultReconnectApi(api: string): string {
	if (api.includes("?") || api.includes("#")) {
		throw new Error(
			"[resumable-stream] Pass reconnectApi explicitly when api contains a query string or hash.",
		);
	}
	return `${api.replace(/\/$/, "")}/stream`;
}

async function readNdjsonStream(
	res: Response,
	options?: {
		signal?: AbortSignal;
	},
): Promise<ReadableStream<UIMessageChunk>> {
	if (!res.body) throw new Error("[resumable-stream] Response has no body.");

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	let readerDone = false;

	const parseChunk = (line: string): UIMessageChunk => {
		try {
			return JSON.parse(line) as UIMessageChunk;
		} catch {
			throw new Error(
				`[resumable-stream] Invalid NDJSON chunk: ${line.slice(0, 200)}`,
			);
		}
	};

	options?.signal?.addEventListener("abort", () => reader.cancel(), {
		once: true,
	});

	return new ReadableStream<UIMessageChunk>({
		async pull(ctrl) {
			while (true) {
				const nl = buf.indexOf("\n");
				if (nl !== -1) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (line.length === 0) continue;
					ctrl.enqueue(parseChunk(line));
					return;
				}

				if (readerDone) {
					buf += decoder.decode();
					const line = buf.trim();
					buf = "";
					if (line.length === 0) {
						ctrl.close();
						return;
					}
					ctrl.enqueue(parseChunk(line));
					ctrl.close();
					return;
				}

				const { done, value } = await reader.read();
				if (done) {
					readerDone = true;
					continue;
				}

				buf += decoder.decode(value, { stream: true });
			}
		},
		cancel() {
			reader.cancel();
		},
	});
}

function makeErrorChunkRecord(): AppendRecord {
	return AppendRecord.string({
		body: JSON.stringify({
			type: "error",
			errorText: "The generation ended before the stream completed.",
		} satisfies UIMessageChunk),
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

	const makeResumable = async (
		streamName: string,
		source: AsyncIterable<UIMessageChunk>,
		options?: MakeResumableOptions,
	): Promise<Response> => {
		const fencingToken = `session-${randomToken(8)}`;
		let matchSeqNumStart = 1;
		let fromSeqNum = 0;

		try {
			if (streamReuse === "shared") {
				const claim = await claimSharedGeneration({
					s2,
					basin,
					stream: streamName,
					fencingToken,
				});
				if (!claim) {
					return new Response("Stream already in use", { status: 409 });
				}
				fromSeqNum = claim.fromSeqNum;
				matchSeqNumStart = claim.matchSeqNumStart;
			} else {
				const ack = await appendFenceCommand(
					s2,
					basin,
					streamName,
					"",
					fencingToken,
				);
				fromSeqNum = ack.start.seqNum;
				matchSeqNumStart = ack.end.seqNum;
			}
		} catch (err) {
			if (err instanceof FencingTokenMismatchError) {
				return new Response("Stream already in use", { status: 409 });
			}
			throw err;
		}

		const write = persistToS2({
			s2,
			basin,
			stream: streamName,
			source,
			fencingToken,
			batchSize,
			lingerDuration,
			matchSeqNumStart,
			toRecord: (chunk) => AppendRecord.string({ body: JSON.stringify(chunk) }),
			finalRecords: (failed) =>
				failed
					? [
							makeErrorChunkRecord(),
							AppendRecord.fence(`error-${randomToken(4)}`),
						]
					: [AppendRecord.fence(`end-${randomToken(4)}`)],
		});

		if (options?.waitUntil) {
			options.waitUntil(write);
		} else {
			await write;
		}

		return Response.json(
			{ stream: streamName, fromSeqNum },
			{ headers: { "Cache-Control": "no-store" } },
		);
	};

	return {
		makeResumable,

		async replay(streamName: string, fromSeqNum?: number): Promise<Response> {
			const iterator = (
				fromSeqNum === undefined
					? replayActiveGenerationStringBodies({
							s2,
							basin,
							stream: streamName,
						})
					: replayGenerationStringBodiesFromSeqNum({
							s2,
							basin,
							stream: streamName,
							fromSeqNum,
						})
			)[Symbol.asyncIterator]();
			const first = await iterator.next();
			if (first.done) {
				return new Response(null, {
					status: 204,
					headers: { "Cache-Control": "no-store" },
				});
			}

			const encoder = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				async start(controller) {
					try {
						controller.enqueue(encoder.encode(`${first.value}\n`));
						while (true) {
							const next = await iterator.next();
							if (next.done) break;
							controller.enqueue(encoder.encode(`${next.value}\n`));
						}
						controller.close();
					} catch (err) {
						controller.error(err);
					}
				},
			});

			return new Response(body, {
				headers: {
					"Content-Type": "application/x-ndjson",
					"Cache-Control": "no-store",
					"X-Accel-Buffering": "no",
				},
			});
		},
	};
}

/**
 * Creates an AI SDK chat transport that reconnects by chat id.
 */
export function createS2Transport<UIMessageT extends UIMessage = UIMessage>({
	api,
	reconnectApi,
	headers,
	fetchClient,
}: S2TransportConfig): ChatTransport<UIMessageT> {
	const fetchFn = fetchClient ?? fetch;

	return {
		async sendMessages({
			trigger,
			chatId,
			messageId,
			messages,
			abortSignal,
			body,
			headers: reqHeaders,
		}) {
			const res = await fetchFn(api, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...flattenHeaders(headers),
					...flattenHeaders(reqHeaders),
				},
				body: JSON.stringify({
					...(body ?? {}),
					id: chatId,
					messages,
					trigger,
					messageId,
				}),
				signal: abortSignal,
			});

			if (!res.ok) {
				const text = await res.text();
				throw new Error(text || `HTTP ${res.status} ${res.statusText}`);
			}

			let fromSeqNum: number | undefined;
			try {
				const body = (await res.json()) as { fromSeqNum?: unknown };
				if (
					typeof body.fromSeqNum === "number" &&
					Number.isSafeInteger(body.fromSeqNum) &&
					body.fromSeqNum >= 0
				) {
					fromSeqNum = body.fromSeqNum;
				}
			} catch {
				// Backward compatibility: older handlers may not return JSON metadata.
			}

			const replayRes = await fetchFn(
				buildReconnectEndpoint(api, reconnectApi, chatId, fromSeqNum),
				{
					method: "GET",
					headers: {
						...flattenHeaders(headers),
						...flattenHeaders(reqHeaders),
					},
					signal: abortSignal,
				},
			);

			if (replayRes.status === 204) {
				throw new Error("No active stream found for the requested chat.");
			}

			if (!replayRes.ok) {
				const text = await replayRes.text();
				throw new Error(
					text || `HTTP ${replayRes.status} ${replayRes.statusText}`,
				);
			}

			return readNdjsonStream(replayRes, { signal: abortSignal });
		},

		async reconnectToStream({ chatId, headers: reqHeaders }) {
			const res = await fetchFn(
				buildReconnectEndpoint(api, reconnectApi, chatId),
				{
					method: "GET",
					headers: {
						...flattenHeaders(headers),
						...flattenHeaders(reqHeaders),
					},
				},
			);

			if (res.status === 204) {
				return null;
			}

			if (!res.ok) {
				const text = await res.text();
				throw new Error(text || `HTTP ${res.status} ${res.statusText}`);
			}

			return readNdjsonStream(res);
		},
	};
}
