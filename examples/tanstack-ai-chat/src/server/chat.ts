import {
	createResumableChat,
	type StreamChunk,
} from "@s2-dev/resumable-stream/tanstack-ai";
import { AppendInput, AppendRecord, S2, S2Error } from "@s2-dev/streamstore";

const HISTORY_STREAM_PREFIX =
	process.env.S2_TANSTACK_CHAT_HISTORY_PREFIX || "tanstack-ai-chat-history";
const LIVE_STREAM_PREFIX =
	process.env.S2_TANSTACK_CHAT_LIVE_PREFIX || "tanstack-ai-chat-live";
const CHAT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const FALLBACK_MESSAGE_ID = "fallback-assistant";

type StreamReuse = "single-use" | "shared";

export type ChatMessage = {
	role: "user" | "assistant";
	content: string;
};

type ChatPayload = {
	id?: unknown;
	message?: unknown;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

function streamReuseFromEnv(): StreamReuse {
	return process.env.S2_TANSTACK_STREAM_REUSE === "shared"
		? "shared"
		: "single-use";
}

type Context = {
	basin: string;
	s2: S2;
	basinClient: ReturnType<S2["basin"]>;
	chat: ReturnType<typeof createResumableChat>;
};

let cachedContext: Context | null = null;

function getContext(): Context {
	if (cachedContext) return cachedContext;
	const accessToken = requireEnv("S2_ACCESS_TOKEN");
	const basin = requireEnv("S2_BASIN");
	const endpoints = endpointsFromEnv();
	const s2 = new S2({ accessToken, endpoints });

	cachedContext = {
		basin,
		s2,
		basinClient: s2.basin(basin),
		chat: createResumableChat({
			accessToken,
			basin,
			endpoints,
			streamReuse: streamReuseFromEnv(),
		}),
	};
	return cachedContext;
}

function historyStreamName(chatId: string): string {
	return `${HISTORY_STREAM_PREFIX}-${chatId}`;
}

function liveStreamName(chatId: string, turnIndex: number): string {
	return streamReuseFromEnv() === "shared"
		? `${LIVE_STREAM_PREFIX}-${chatId}`
		: `${LIVE_STREAM_PREFIX}-${chatId}-${turnIndex}`;
}

function turnIndexForNewTurn(history: ChatMessage[]): number {
	return history.filter((message) => message.role === "user").length;
}

function activeTurnIndex(history: ChatMessage[]): number | null {
	const userCount = history.filter((message) => message.role === "user").length;
	const assistantCount = history.filter(
		(message) => message.role === "assistant",
	).length;
	return userCount > assistantCount ? userCount - 1 : null;
}

export function isValidChatId(value: unknown): value is string {
	return typeof value === "string" && CHAT_ID_PATTERN.test(value);
}

function isChatMessage(value: unknown): value is ChatMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		((value as { role?: unknown }).role === "user" ||
			(value as { role?: unknown }).role === "assistant") &&
		typeof (value as { content?: unknown }).content === "string"
	);
}

async function ensureStreamExists(
	context: Context,
	streamName: string,
): Promise<void> {
	await context.basinClient.streams
		.create({ stream: streamName })
		.catch((error: unknown) => {
			if (!(error instanceof S2Error && error.status === 409)) throw error;
		});
}

async function readHistory(chatId: string): Promise<ChatMessage[]> {
	const context = getContext();
	const streamName = historyStreamName(chatId);
	await ensureStreamExists(context, streamName);

	const stream = context.basinClient.stream(streamName);
	const messages: ChatMessage[] = [];
	const session = await stream.readSession(
		{ start: { from: { seqNum: 0 } }, stop: { waitSecs: 0 } },
		{ as: "string" },
	);

	try {
		for await (const record of session) {
			if (typeof record.body !== "string") continue;
			try {
				const message = JSON.parse(record.body);
				if (isChatMessage(message)) messages.push(message);
			} catch {
				// Ignore malformed records so one bad write does not break replay.
			}
		}
	} finally {
		await session[Symbol.asyncDispose]?.();
	}

	return messages;
}

async function appendHistoryMessage(
	chatId: string,
	message: ChatMessage,
): Promise<void> {
	const context = getContext();
	const streamName = historyStreamName(chatId);
	await ensureStreamExists(context, streamName);
	await context.basinClient
		.stream(streamName)
		.append(
			AppendInput.create([
				AppendRecord.string({ body: JSON.stringify(message) }),
			]),
		);
}

async function* fallbackStream(
	prompt: string,
	messageId = FALLBACK_MESSAGE_ID,
): AsyncIterable<StreamChunk> {
	const words = `Echo: ${prompt}`.split(/(\s+)/).filter(Boolean);
	const ts = Date.now();
	yield { type: "RUN_STARTED", timestamp: ts };
	yield {
		type: "TEXT_MESSAGE_START",
		timestamp: ts + 1,
		messageId,
		role: "assistant",
	};

	for (const [index, word] of words.entries()) {
		await sleep(6);
		yield {
			type: "TEXT_MESSAGE_CONTENT",
			timestamp: ts + 2 + index,
			messageId,
			delta: word,
		};
	}

	yield {
		type: "TEXT_MESSAGE_END",
		timestamp: ts + 2 + words.length,
		messageId,
	};
	yield { type: "RUN_FINISHED", timestamp: ts + 3 + words.length };
}

async function createChunks(
	messages: ChatMessage[],
): Promise<AsyncIterable<StreamChunk>> {
	const prompt = messages.at(-1)?.content ?? "";

	if (!process.env.OPENAI_API_KEY) {
		return fallbackStream(prompt);
	}

	const [{ chat }, { openaiText }] = await Promise.all([
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

	return chat({
		adapter: openaiText(model),
		messages,
	}) as AsyncIterable<StreamChunk>;
}

function persistCompletedAssistantMessage(
	chatId: string,
	userMessage: ChatMessage,
	source: AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
	let fullText = "";
	let persisted = false;

	return (async function* () {
		await appendHistoryMessage(chatId, userMessage);

		for await (const chunk of source) {
			if (
				chunk.type === "TEXT_MESSAGE_CONTENT" &&
				typeof chunk.delta === "string"
			) {
				fullText += chunk.delta;
			}
			if (chunk.type === "RUN_FINISHED" && !persisted) {
				persisted = true;
				await appendHistoryMessage(chatId, {
					role: "assistant",
					content: fullText,
				});
			}
			yield chunk;
		}
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
		if (
			!isValidChatId(body.id) ||
			!isChatMessage(body.message) ||
			body.message.role !== "user"
		) {
			return new Response("Expected { id, message } with a user message.", {
				status: 400,
			});
		}

		const context = getContext();
		const history = await readHistory(body.id);
		const streamName = liveStreamName(body.id, turnIndexForNewTurn(history));
		await ensureStreamExists(context, streamName);
		const source = await createChunks([...history, body.message]);

		return context.chat.makeResumable(
			streamName,
			persistCompletedAssistantMessage(body.id, body.message, source),
		);
	} catch (error) {
		return routeError(error);
	}
}

export async function replayChat(chatId: string | null): Promise<Response> {
	try {
		if (!isValidChatId(chatId)) {
			return new Response("Missing id query parameter", { status: 400 });
		}

		let streamName: string;
		if (streamReuseFromEnv() === "shared") {
			streamName = liveStreamName(chatId, 0);
		} else {
			const history = await readHistory(chatId);
			const activeIndex = activeTurnIndex(history);
			if (activeIndex === null) return new Response(null, { status: 204 });
			streamName = liveStreamName(chatId, activeIndex);
		}

		return getContext().chat.replay(streamName);
	} catch (error) {
		return routeError(error);
	}
}

export async function getHistory(chatId: string | null): Promise<Response> {
	try {
		if (!isValidChatId(chatId)) {
			return new Response("Missing id query parameter", { status: 400 });
		}

		return Response.json(
			{ messages: await readHistory(chatId) },
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (error) {
		return routeError(error);
	}
}
