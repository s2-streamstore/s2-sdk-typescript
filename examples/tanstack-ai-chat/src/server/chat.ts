import {
	type Chunk,
	createResumableChat,
} from "@s2-dev/resumable-stream/tanstack-ai";
import {
	convertMessagesToModelMessages,
	type ModelMessage,
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

const chat = createResumableChat({
	accessToken: requireEnv("S2_ACCESS_TOKEN"),
	basin: requireEnv("S2_BASIN"),
	endpoints: endpointsFromEnv(),
	mode: "session",
});

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
	const latestPrompt =
		getModelMessageText(
			modelMessages.findLast((message) => message.role === "user") ?? {
				role: "user",
				content: "",
			},
		) ?? "";

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
	}) as AsyncIterable<Chunk>;
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

		const source = await createChunks(body.messages as UIMessage[], {
			abortController: active,
		});

		try {
			return await chat.makeResumable(
				name,
				withActiveTracking(name, active, source),
				{ delivery: "replay" },
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

export async function replayChat(
	chatId: string | null,
	fromSeqNumValue?: string | null,
): Promise<Response> {
	try {
		if (!isValidChatId(chatId)) {
			return new Response("Missing id query parameter", { status: 400 });
		}
		return chat.replay(streamName(chatId), {
			fromSeqNum: parseFromSeqNum(fromSeqNumValue ?? null),
		});
	} catch (error) {
		return routeError(error);
	}
}
