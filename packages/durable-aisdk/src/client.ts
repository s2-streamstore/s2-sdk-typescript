import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type { S2TransportConfig } from "./types.js";

function flattenHeaders(h?: HeadersInit): Record<string, string> {
	if (!h) return {};
	if (h instanceof Headers)
		return Object.fromEntries(h as unknown as Iterable<[string, string]>);
	if (Array.isArray(h)) return Object.fromEntries(h);
	return { ...h };
}

async function readNdjsonStream(
	res: Response,
	signal?: AbortSignal,
): Promise<ReadableStream<UIMessageChunk>> {
	if (!res.body) throw new Error("[durable-aisdk] Response has no body.");

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";

	signal?.addEventListener("abort", () => reader.cancel(), { once: true });

	return new ReadableStream<UIMessageChunk>({
		async pull(ctrl) {
			while (true) {
				const nl = buf.indexOf("\n");
				if (nl !== -1) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (line.length > 0) {
						try {
							ctrl.enqueue(JSON.parse(line) as UIMessageChunk);
							return;
						} catch {}
					}
					continue;
				}

				const { done, value } = await reader.read();
				if (done) {
					if (buf.trim().length > 0) {
						try {
							ctrl.enqueue(JSON.parse(buf.trim()) as UIMessageChunk);
						} catch {}
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

/**
 * Create an AI SDK `ChatTransport` that persists generations via your server.
 *
 * The server writes AI chunks to S2 (via {@link createDurableChat}) and
 * exposes a replay endpoint. This transport reads from your server — no
 * direct S2 connection from the browser.
 *
 * @example
 * ```tsx
 * import { useChat } from "ai/react";
 * import { createS2Transport } from "@s2-dev/durable-aisdk";
 *
 * const transport = createS2Transport({ api: "/api/chat" });
 *
 * export default function Chat() {
 *   const { messages, input, handleSubmit, handleInputChange } = useChat({
 *     transport,
 *     experimental_resume: true,
 *   });
 *   // ...
 * }
 * ```
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

			const { stream } = (await res.json()) as { stream: string };
			if (!stream) {
				throw new Error(
					"[durable-aisdk] Server response missing { stream } field.",
				);
			}

			const endpoint =
				reconnectApi ??
				`${api.replace(/\/$/, "")}/${encodeURIComponent(chatId)}/stream`;
			const replayRes = await fetchFn(endpoint, {
				method: "GET",
				headers: {
					...flattenHeaders(headers),
					...flattenHeaders(reqHeaders),
				},
				signal: abortSignal,
			});

			if (!replayRes.ok) {
				const text = await replayRes.text();
				throw new Error(
					text || `HTTP ${replayRes.status} ${replayRes.statusText}`,
				);
			}

			return readNdjsonStream(replayRes, abortSignal);
		},

		async reconnectToStream({ chatId, headers: reqHeaders }) {
			const endpoint =
				reconnectApi ??
				`${api.replace(/\/$/, "")}/${encodeURIComponent(chatId)}/stream`;

			const res = await fetchFn(endpoint, {
				method: "GET",
				headers: {
					...flattenHeaders(headers),
					...flattenHeaders(reqHeaders),
				},
			});

			if (res.status === 204) return null;

			if (!res.ok) {
				const text = await res.text();
				throw new Error(text || `HTTP ${res.status} ${res.statusText}`);
			}

			return readNdjsonStream(res);
		},
	};
}
