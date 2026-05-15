import {
	type Chunk,
	createResumableChat,
} from "@s2-dev/resumable-stream/tanstack-ai";
import { S2, S2Error } from "@s2-dev/streamstore";
import {
	convertMessagesToModelMessages,
	type ModelMessage,
	type StreamChunk,
	StreamProcessor,
	type UIMessage,
} from "@tanstack/ai";

const STREAM_PREFIX =
	process.env.S2_TANSTACK_CHAT_STREAM_PREFIX || "tanstack-ai-chat";
const CHAT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const FALLBACK_MESSAGE_ID = "fallback-assistant";

type ChatPayload = {
	id?: unknown;
	messages?: unknown;
};

type ChatHistory = {
	messages: UIMessage[];
	cursor?: number;
};

export function isValidChatId(value: unknown): value is string {
	return typeof value === "string" && CHAT_ID_PATTERN.test(value);
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Set ${name} before running this example.`);
	return value;
}

function endpointsFromEnv() {
	const account = process.env.S2_ACCOUNT_ENDPOINT;
	const basin = process.env.S2_BASIN_ENDPOINT;
	return account || basin
		? { account: account || undefined, basin: basin || undefined }
		: undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				resolve();
			},
			{ once: true },
		);
	});
}

const accessToken = requireEnv("S2_ACCESS_TOKEN");
const basin = requireEnv("S2_BASIN");
const endpoints = endpointsFromEnv();

const chat = createResumableChat({
	accessToken,
	basin,
	endpoints,
	mode: "session",
});
const s2 = new S2({ accessToken, endpoints });

// Process-local active-generation tracking. The resumable-stream package no
// longer owns this; we keep the abort controller for each in-flight turn here
// so `/stop` can abort the upstream model call.
const activeGenerations = new Map<string, AbortController>();

function streamName(chatId: string): string {
	return `${STREAM_PREFIX}-${chatId}`;
}

function parseFromSeqNum(value: string | null): number | undefined {
	if (value === null) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
	return parsed;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Cache-Control": "no-store",
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}

function snapshotChunk(messages: UIMessage[]): Chunk {
	return {
		type: "MESSAGES_SNAPSHOT",
		timestamp: Date.now(),
		messages,
	};
}

function isUiMessageArray(value: unknown): value is UIMessage[] {
	return (
		Array.isArray(value) &&
		value.every(
			(message) =>
				typeof message === "object" &&
				message !== null &&
				typeof (message as { id?: unknown }).id === "string" &&
				typeof (message as { role?: unknown }).role === "string" &&
				Array.isArray((message as { parts?: unknown }).parts),
		)
	);
}

async function readHistory(chatId: string): Promise<ChatHistory> {
	const session = await s2
		.basin(basin)
		.stream(streamName(chatId))
		.readSession(
			{
				start: { from: { seqNum: 0 }, clamp: true },
				stop: { waitSecs: 0 },
			},
			{ as: "string" },
		)
		.catch((error: unknown) => {
			if (error instanceof S2Error && error.status === 404) return null;
			throw error;
		});
	const history: ChatHistory = { messages: [] };
	let processor: StreamProcessor | null = null;

	if (!session) return history;

	try {
		for await (const record of session) {
			history.cursor = record.seqNum + 1;
			if (!record.body) continue;
			try {
				const chunk = JSON.parse(record.body) as Chunk & {
					type?: unknown;
					messages?: unknown;
				};
				if (
					chunk.type === "MESSAGES_SNAPSHOT" &&
					isUiMessageArray(chunk.messages)
				) {
					history.messages = chunk.messages;
					processor = new StreamProcessor({
						initialMessages: history.messages,
					});
					continue;
				}

				processor ??= new StreamProcessor({
					initialMessages: history.messages,
				});
				processor.processChunk(chunk as StreamChunk);
			} catch {}
		}
	} finally {
		await session[Symbol.asyncDispose]?.();
	}

	if (processor) {
		processor.finalizeStream();
		history.messages = processor.getMessages();
	}

	return history;
}

function getModelMessageText(message: ModelMessage): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter(
			(part): part is { type: "text"; content: string } =>
				part.type === "text" && typeof part.content === "string",
		)
		.map((part) => part.content)
		.join("");
}

async function* fallbackStream(
	prompt: string,
	messageId = FALLBACK_MESSAGE_ID,
	signal?: AbortSignal,
): AsyncIterable<Chunk> {
	const words = `Echo: ${prompt}`.split(/(\s+)/).filter(Boolean);
	const timestamp = Date.now();
	const runId = `fallback-run-${timestamp}`;

	yield { type: "RUN_STARTED", timestamp, runId };
	yield {
		type: "TEXT_MESSAGE_START",
		timestamp: timestamp + 1,
		messageId,
		role: "assistant",
	};

	for (const [index, word] of words.entries()) {
		await sleep(8, signal);
		if (signal?.aborted) return;
		yield {
			type: "TEXT_MESSAGE_CONTENT",
			timestamp: timestamp + 2 + index,
			messageId,
			delta: word,
		};
	}

	yield {
		type: "TEXT_MESSAGE_END",
		timestamp: timestamp + 2 + words.length,
		messageId,
	};
	yield {
		type: "RUN_FINISHED",
		timestamp: timestamp + 3 + words.length,
		runId,
		model: "fallback",
		finishReason: "stop",
	};
}

async function createChunks(
	messages: UIMessage[],
	{ abortController }: { abortController: AbortController },
): Promise<AsyncIterable<Chunk>> {
	const modelMessages = convertMessagesToModelMessages(messages);
	let latestUserMessage: ModelMessage | undefined;
	for (let index = modelMessages.length - 1; index >= 0; index -= 1) {
		const message = modelMessages[index];
		if (message?.role === "user") {
			latestUserMessage = message;
			break;
		}
	}
	const latestPrompt =
		getModelMessageText(latestUserMessage ?? { role: "user", content: "" }) ??
		"";

	if (!process.env.OPENAI_API_KEY) {
		return fallbackStream(
			latestPrompt,
			FALLBACK_MESSAGE_ID,
			abortController.signal,
		);
	}

	const [{ chat: tanstackChat }, { openaiText }] = await Promise.all([
		import("@tanstack/ai"),
		import("@tanstack/ai-openai"),
	]).catch(() => {
		throw new Error(
			"Install @tanstack/ai and @tanstack/ai-openai, or unset OPENAI_API_KEY to use the fallback stream.",
		);
	});

	const model = (process.env.OPENAI_MODEL ?? "gpt-4o-mini") as Parameters<
		typeof openaiText
	>[0];

	return tanstackChat({
		adapter: openaiText(model),
		messages: modelMessages,
		abortController,
	} as unknown as Parameters<typeof tanstackChat>[0]) as AsyncIterable<Chunk>;
}

// Wraps the chunk stream so we yield each event through, see what's terminal,
// and clear the active-generations entry on completion / abort.
function withActiveTracking(
	name: string,
	active: AbortController,
	source: AsyncIterable<Chunk>,
): AsyncIterable<Chunk> {
	return (async function* () {
		try {
			for await (const chunk of source) {
				if (active.signal.aborted) return;
				yield chunk;
			}
		} finally {
			if (activeGenerations.get(name) === active) {
				activeGenerations.delete(name);
			}
		}
	})();
}

function withMessageHistory(
	messages: UIMessage[],
	source: AsyncIterable<Chunk>,
): AsyncIterable<Chunk> {
	return (async function* () {
		const processor = new StreamProcessor({ initialMessages: messages });
		yield snapshotChunk(messages);

		for await (const chunk of source) {
			yield chunk;
			processor.processChunk(chunk as StreamChunk);
		}

		processor.finalizeStream();
		yield snapshotChunk(processor.getMessages());
	})();
}

function routeError(error: unknown): Response {
	console.error("[tanstack-ai-chat] request failed:", error);
	return new Response(error instanceof Error ? error.message : String(error), {
		status: 500,
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}

export async function postChat(request: Request): Promise<Response> {
	try {
		const body = (await request.json()) as ChatPayload;
		if (!isValidChatId(body.id)) {
			return new Response("Missing or invalid id", { status: 400 });
		}
		if (!Array.isArray(body.messages) || body.messages.length === 0) {
			return new Response("Expected at least one message", { status: 400 });
		}

		const name = streamName(body.id);
		if (activeGenerations.has(name)) {
			return new Response("Stream already has an active generation", {
				status: 409,
			});
		}

		const active = new AbortController();
		activeGenerations.set(name, active);

		const messages = body.messages as UIMessage[];
		const source = await createChunks(messages, {
			abortController: active,
		});

		try {
			return await chat.makeResumable(
				name,
				withActiveTracking(name, active, withMessageHistory(messages, source)),
				{
					delivery: "replay",
					// Without waitUntil, makeResumable awaits persistence so the POST
					// holds open for the full generation. Fire-and-forget the promise
					// here; Bun keeps the task alive past the response.
					waitUntil: (p) =>
						p.catch((err) =>
							console.error("[tanstack-ai-chat] persist failed:", err),
						),
				},
			);
		} catch (err) {
			activeGenerations.delete(name);
			throw err;
		}
	} catch (error) {
		return routeError(error);
	}
}

export async function stopChat(request: Request): Promise<Response> {
	try {
		const body = (await request.json()) as ChatPayload;
		if (!isValidChatId(body.id)) {
			return new Response("Missing or invalid id", { status: 400 });
		}
		const active = activeGenerations.get(streamName(body.id));
		active?.abort();
		return new Response(null, {
			status: active ? 202 : 204,
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		return routeError(error);
	}
}

export async function historyChat(chatId: string | null): Promise<Response> {
	try {
		if (!isValidChatId(chatId)) {
			return json({ messages: [] }, 400);
		}
		return json(await readHistory(chatId));
	} catch (error) {
		return routeError(error);
	}
}

export async function replayChat(
	chatId: string | null,
	fromSeqNumValue?: string | null,
	live = false,
): Promise<Response> {
	try {
		if (!isValidChatId(chatId)) {
			return new Response("Missing id query parameter", { status: 400 });
		}
		return chat.replay(streamName(chatId), {
			fromSeqNum: parseFromSeqNum(fromSeqNumValue ?? null),
			live,
		});
	} catch (error) {
		return routeError(error);
	}
}
