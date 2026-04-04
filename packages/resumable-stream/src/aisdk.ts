import type { S2Endpoints, S2EndpointsInit } from "@s2-dev/streamstore";
import {
	AppendInput,
	AppendRecord,
	FencingTokenMismatchError,
	randomToken,
	S2,
} from "@s2-dev/streamstore";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import {
	appendFenceRecord,
	persistToS2,
	replayStringBodies,
} from "./shared.js";

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LINGER_DURATION = 50;
const STORE_KEY_PREFIX = "s2-resumable-stream:";
const fallbackStreamStore = new Map<string, string>();

export interface DurableChatConfig {
	accessToken: string;
	basin: string;
	endpoints?: S2Endpoints | S2EndpointsInit;
	batchSize?: number;
	lingerDuration?: number;
}

export interface PersistOptions {
	waitUntil?: (promise: Promise<unknown>) => void;
}

export interface DurableChat {
	persist(
		streamName: string,
		source: AsyncIterable<UIMessageChunk>,
		options?: PersistOptions,
	): Promise<Response>;
	replay(streamName: string): Promise<Response>;
}

export interface StreamStateStore {
	get(chatId: string): string | null;
	set(chatId: string, streamName: string): void;
	delete(chatId: string): void;
}

export interface S2TransportConfig {
	api: string;
	reconnectApi?: string;
	headers?: HeadersInit;
	fetchClient?: typeof fetch;
	streamStateStore?: StreamStateStore;
}

function flattenHeaders(h?: HeadersInit): Record<string, string> {
	if (!h) return {};
	if (h instanceof Headers)
		return Object.fromEntries(h as unknown as Iterable<[string, string]>);
	if (Array.isArray(h)) return Object.fromEntries(h);
	return { ...h };
}

function storageKey(chatId: string): string {
	return `${STORE_KEY_PREFIX}${chatId}`;
}

function defaultStreamStateStore(): StreamStateStore {
	return {
		get(chatId) {
			const key = storageKey(chatId);
			try {
				if (typeof sessionStorage !== "undefined") {
					return sessionStorage.getItem(key);
				}
			} catch {
				// Fall back to process-local memory when sessionStorage is unavailable.
			}
			return fallbackStreamStore.get(key) ?? null;
		},
		set(chatId, streamName) {
			const key = storageKey(chatId);
			try {
				if (typeof sessionStorage !== "undefined") {
					sessionStorage.setItem(key, streamName);
					return;
				}
			} catch {
				// Fall back to process-local memory when sessionStorage is unavailable.
			}
			fallbackStreamStore.set(key, streamName);
		},
		delete(chatId) {
			const key = storageKey(chatId);
			try {
				if (typeof sessionStorage !== "undefined") {
					sessionStorage.removeItem(key);
				}
			} catch {
				// Fall back to process-local memory when sessionStorage is unavailable.
			}
			fallbackStreamStore.delete(key);
		},
	};
}

function withQueryParam(url: string, key: string, value: string): string {
	const [pathname, query = ""] = url.split("?", 2);
	const params = new URLSearchParams(query);
	params.set(key, value);
	const search = params.toString();
	return search ? `${pathname}?${search}` : pathname;
}

function buildReplayEndpoint(
	api: string,
	reconnectApi: string | undefined,
	stream: string,
): string {
	const base = reconnectApi ?? `${api.replace(/\/$/, "")}/stream`;
	return withQueryParam(base, "stream", stream);
}

function isTerminalChunk(chunk: UIMessageChunk): boolean {
	return (
		chunk.type === "finish" || chunk.type === "abort" || chunk.type === "error"
	);
}

async function readNdjsonStream(
	res: Response,
	options?: {
		signal?: AbortSignal;
		onTerminalChunk?: () => void;
	},
): Promise<ReadableStream<UIMessageChunk>> {
	if (!res.body) throw new Error("[resumable-stream] Response has no body.");

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	let handledTerminal = false;

	const markTerminal = () => {
		if (handledTerminal) return;
		handledTerminal = true;
		options?.onTerminalChunk?.();
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
					try {
						const chunk = JSON.parse(line) as UIMessageChunk;
						if (isTerminalChunk(chunk)) markTerminal();
						ctrl.enqueue(chunk);
						return;
					} catch {
						continue;
					}
				}

				const { done, value } = await reader.read();
				if (done) {
					if (buf.trim().length > 0) {
						try {
							const chunk = JSON.parse(buf.trim()) as UIMessageChunk;
							if (isTerminalChunk(chunk)) markTerminal();
							ctrl.enqueue(chunk);
						} catch {
							// Ignore malformed trailing data.
						}
					}
					ctrl.close();
					return;
				}

				buf += decoder.decode(value, { stream: true });
			}
		},
		cancel() {
			reader.cancel();
		},
	});
}

async function writeErrorChunk(
	s2: S2,
	basin: string,
	stream: string,
	fencingToken: string,
): Promise<void> {
	const record = AppendRecord.string({
		body: JSON.stringify({
			type: "error",
			errorText: "The generation ended before the stream completed.",
		} satisfies UIMessageChunk),
	});
	const input = AppendInput.create([record], { fencingToken });
	await s2.basin(basin).stream(stream).append(input);
}

export function createDurableChat(config: DurableChatConfig): DurableChat {
	const s2 = new S2({
		accessToken: config.accessToken,
		endpoints: config.endpoints,
	});
	const basin = config.basin;
	const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
	const lingerDuration = config.lingerDuration ?? DEFAULT_LINGER_DURATION;

	return {
		async persist(
			streamName: string,
			source: AsyncIterable<UIMessageChunk>,
			options?: PersistOptions,
		): Promise<Response> {
			const fencingToken = `session-${randomToken(8)}`;

			try {
				await appendFenceRecord(s2, basin, streamName, "", fencingToken);
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
				toRecord: (chunk) =>
					AppendRecord.string({ body: JSON.stringify(chunk) }),
				terminalFenceBody: (failed) =>
					failed ? `error-${randomToken(4)}` : `end-${randomToken(4)}`,
				onFailureBeforeFence: () =>
					writeErrorChunk(s2, basin, streamName, fencingToken),
			});

			if (options?.waitUntil) {
				options.waitUntil(
					write.catch((err) =>
						console.error("[resumable-stream] persist failed:", err),
					),
				);
			} else {
				await write;
			}

			return Response.json(
				{ stream: streamName },
				{ headers: { "Cache-Control": "no-store" } },
			);
		},

		async replay(streamName: string): Promise<Response> {
			const encoder = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				async start(controller) {
					try {
						for await (const record of replayStringBodies({
							s2,
							basin,
							stream: streamName,
						})) {
							controller.enqueue(encoder.encode(`${record}\n`));
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

export function createS2Transport<UIMessageT extends UIMessage = UIMessage>({
	api,
	reconnectApi,
	headers,
	fetchClient,
	streamStateStore = defaultStreamStateStore(),
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

			const { stream } = (await res.json()) as { stream: string };
			if (!stream) {
				throw new Error(
					"[resumable-stream] Server response missing { stream } field.",
				);
			}

			streamStateStore.set(chatId, stream);

			const replayRes = await fetchFn(
				buildReplayEndpoint(api, reconnectApi, stream),
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
				streamStateStore.delete(chatId);
				throw new Error("No active stream found for the requested chat.");
			}

			if (!replayRes.ok) {
				const text = await replayRes.text();
				throw new Error(
					text || `HTTP ${replayRes.status} ${replayRes.statusText}`,
				);
			}

			return readNdjsonStream(replayRes, {
				signal: abortSignal,
				onTerminalChunk: () => streamStateStore.delete(chatId),
			});
		},

		async reconnectToStream({ chatId, headers: reqHeaders }) {
			const stream = streamStateStore.get(chatId);
			if (!stream) return null;

			const res = await fetchFn(
				buildReplayEndpoint(api, reconnectApi, stream),
				{
					method: "GET",
					headers: {
						...flattenHeaders(headers),
						...flattenHeaders(reqHeaders),
					},
				},
			);

			if (res.status === 204) {
				streamStateStore.delete(chatId);
				return null;
			}

			if (!res.ok) {
				const text = await res.text();
				throw new Error(text || `HTTP ${res.status} ${res.statusText}`);
			}

			return readNdjsonStream(res, {
				onTerminalChunk: () => streamStateStore.delete(chatId),
			});
		},
	};
}
