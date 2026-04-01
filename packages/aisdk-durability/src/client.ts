import { S2 } from "@s2-dev/streamstore";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type { S2ChatTransportConfig, S2ReadConfig } from "./types.js";
import { isFenceRecord, isTerminalFence } from "./fence.js";

/**
 * Open an S2 read session and return a ReadableStream of UIMessageChunks.
 *
 * Uses the S2 SDK directly — SSE parsing, retries, and ping timeouts are
 * handled by `@s2-dev/streamstore` under the hood.
 */
async function openS2Stream(
	streamName: string,
	cfg: S2ReadConfig,
): Promise<ReadableStream<UIMessageChunk>> {
	const s2 = new S2({
		accessToken: cfg.accessToken,
		endpoints: cfg.baseUrl
			? { basin: cfg.baseUrl }
			: undefined,
	});

	const handle = s2.basin(cfg.basin).stream(streamName);
	const session = await handle.readSession({
		start: { from: { seqNum: 0 } },
	});

	const iter = session[Symbol.asyncIterator]();

	return new ReadableStream<UIMessageChunk>({
		async pull(ctrl) {
			const { done, value: record } = await iter.next();
			if (done) {
				ctrl.close();
				await handle.close();
				return;
			}

			if (isFenceRecord(record)) {
				if (isTerminalFence(record)) {
					ctrl.close();
					await handle.close();
					return;
				}
				return;
			}

			if (record.body) {
				try {
					ctrl.enqueue(JSON.parse(record.body) as UIMessageChunk);
				} catch {
					// skip malformed
				}
			}
		},
		async cancel() {
			await handle.close();
		},
	});
}

function flattenHeaders(h?: HeadersInit): Record<string, string> {
	if (!h) return {};
	if (h instanceof Headers) return Object.fromEntries(h.entries());
	if (Array.isArray(h)) return Object.fromEntries(h);
	return { ...h };
}

async function extractStreamName(res: Response): Promise<string> {
	const body = (await res.json()) as { stream?: string };
	if (typeof body.stream === "string" && body.stream) return body.stream;
	throw new Error(
		"[s2/aisdk-transport] Server response missing { stream } field.",
	);
}

/**
 * Create a Vercel AI SDK `ChatTransport` backed by S2.
 *
 * Your server writes AI chunks to S2 (via {@link createS2ChatPersistence})
 * and responds with `{ stream: "name" }`. This transport reads them back
 * using the S2 SDK's built-in SSE reader — no custom parsing needed.
 *
 * @example
 * ```tsx
 * import { useChat } from "ai/react";
 * import { createS2ChatTransport } from "@s2-dev/aisdk-transport";
 *
 * const transport = createS2ChatTransport({
 *   api: "/api/chat",
 *   s2: {
 *     accessToken: process.env.NEXT_PUBLIC_S2_READ_TOKEN!,
 *     basin: "my-basin",
 *   },
 * });
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
export function createS2ChatTransport<
	UIMessageT extends UIMessage = UIMessage,
>({
	api,
	reconnectApi,
	s2,
	headers,
	fetchClient,
}: S2ChatTransportConfig): ChatTransport<UIMessageT> {
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
				throw new Error(
					text || `HTTP ${res.status} ${res.statusText}`,
				);
			}

			const name = await extractStreamName(res);
			return openS2Stream(name, s2);
		},

		async reconnectToStream({ chatId, headers: reqHeaders }) {
			const endpoint =
				reconnectApi ?? `${api.replace(/\/$/, "")}/${chatId}/stream`;

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
				throw new Error(
					text || `HTTP ${res.status} ${res.statusText}`,
				);
			}

			const name = await extractStreamName(res);
			return openS2Stream(name, s2);
		},
	};
}
