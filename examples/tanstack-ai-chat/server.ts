#!/usr/bin/env bun

import { dirname, join } from "node:path";
import {
	createS2SessionHandler,
	type ChatMessage,
	type S2SessionRecord,
	type StreamChunk,
} from "@s2-dev/resumable-stream/tanstack-ai";
import { S2, S2Error } from "@s2-dev/streamstore";

const PORT = Number.parseInt(process.env.PORT || "3458", 10);
const HOSTNAME = process.env.HOSTNAME || "127.0.0.1";
const PUBLIC_DIR = join(dirname(import.meta.path), "public");
const STREAM_PREFIX = process.env.S2_TANSTACK_CHAT_PREFIX || "tanstack-ai-chat";
const CHAT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_ECHO_DELAY_MS = 12;
const DEFAULT_SESSION_BATCH_SIZE = 16;
const DEFAULT_SESSION_LINGER_MS = 5;

type Importer = (specifier: string) => Promise<any>;
const importOptional: Importer = (specifier) => import(specifier);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) throw new Error("Set S2_ACCESS_TOKEN");

const basin = process.env.S2_BASIN;
if (!basin) throw new Error("Set S2_BASIN");

function numberFromEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const echoDelayMs = numberFromEnv(
	"S2_TANSTACK_ECHO_DELAY_MS",
	DEFAULT_ECHO_DELAY_MS,
);
const sessionBatchSize = Math.max(
	1,
	numberFromEnv("S2_TANSTACK_SESSION_BATCH_SIZE", DEFAULT_SESSION_BATCH_SIZE),
);
const sessionLingerMs = numberFromEnv(
	"S2_TANSTACK_SESSION_LINGER_MS",
	DEFAULT_SESSION_LINGER_MS,
);

function streamNameForChat(chatId: string): string {
	return `${STREAM_PREFIX}-${chatId}`;
}

function endpointsFromEnv() {
	const account = process.env.S2_ACCOUNT_ENDPOINT;
	const basin = process.env.S2_BASIN_ENDPOINT;
	return account || basin
		? {
				account: account || undefined,
				basin: basin || undefined,
			}
		: undefined;
}

function isValidChatId(value: unknown): value is string {
	return typeof value === "string" && CHAT_ID_PATTERN.test(value);
}

function isUserMessage(value: unknown): value is ChatMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { role?: unknown }).role === "user" &&
		typeof (value as { content?: unknown }).content === "string"
	);
}

function isStreamNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "stream_not_found"
	);
}

async function* fallbackStream(prompt: string): AsyncIterable<StreamChunk> {
	const words = `Echo: ${prompt}`.split(/(\s+)/).filter(Boolean);
	const timestamp = Date.now();
	yield { type: "RUN_STARTED", timestamp };
	yield {
		type: "TEXT_MESSAGE_START",
		timestamp: timestamp + 1,
		messageId: "assistant-1",
		role: "assistant",
	};
	for (const [index, word] of words.entries()) {
		if (echoDelayMs > 0) {
			await sleep(echoDelayMs);
		}
		yield {
			type: "TEXT_MESSAGE_CONTENT",
			timestamp: timestamp + 2 + index,
			messageId: "assistant-1",
			delta: word,
		};
	}
	yield {
		type: "TEXT_MESSAGE_END",
		timestamp: timestamp + 2 + words.length,
		messageId: "assistant-1",
	};
	yield { type: "RUN_FINISHED", timestamp: timestamp + 3 + words.length };
}

async function createStream(
	messages: ChatMessage[],
): Promise<AsyncIterable<StreamChunk>> {
	const lastMessage = messages.at(-1);
	const prompt =
		typeof lastMessage?.content === "string" ? lastMessage.content : "";

	if (!process.env.OPENAI_API_KEY) {
		return fallbackStream(prompt);
	}

	const [{ chat }, { openaiText }] = await Promise.all([
		importOptional("@tanstack/ai"),
		importOptional("@tanstack/ai-openai"),
	]).catch(() => {
		throw new Error(
			"Install @tanstack/ai and @tanstack/ai-openai, or unset OPENAI_API_KEY to use the fallback stream.",
		);
	});

	return chat({
		adapter: openaiText(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
		messages,
	}) as AsyncIterable<StreamChunk>;
}

function reduceTextMessages(records: S2SessionRecord[]): ChatMessage[] {
	const messages: ChatMessage[] = [];
	const messageById = new Map<string, ChatMessage>();
	for (const { chunk } of records) {
		if (typeof chunk.messageId !== "string") continue;
		const messageId = chunk.messageId;
		if (chunk.type === "TEXT_MESSAGE_START") {
			const message: ChatMessage = {
				id: messageId,
				role: typeof chunk.role === "string" ? chunk.role : "assistant",
				content: "",
			};
			messageById.set(messageId, message);
			messages.push(message);
			continue;
		}
		if (chunk.type === "TEXT_MESSAGE_CONTENT") {
			let message = messageById.get(messageId);
			if (!message) {
				message = { id: messageId, role: "assistant", content: "" };
				messageById.set(messageId, message);
				messages.push(message);
			}
			if (typeof chunk.delta === "string") {
				message.content = `${String(message.content ?? "")}${chunk.delta}`;
			}
		}
	}
	return messages;
}

function activeRunId(records: S2SessionRecord[]): string | null {
	const active = new Set<string>();
	let latest: string | null = null;
	for (const { chunk } of records) {
		const runId = typeof chunk.runId === "string" ? chunk.runId : null;
		if (!runId) continue;
		if (chunk.type === "RUN_STARTED") {
			active.add(runId);
			latest = runId;
			continue;
		}
		if (chunk.type === "RUN_FINISHED" || chunk.type === "RUN_ERROR") {
			active.delete(runId);
			if (latest === runId) latest = null;
			continue;
		}
		latest = runId;
	}
	return latest && active.has(latest) ? latest : null;
}

const pending = new Set<Promise<unknown>>();
const endpoints = endpointsFromEnv();
const s2 = new S2({
	accessToken,
	endpoints,
});
const basinClient = s2.basin(basin);
const handler = createS2SessionHandler({
	accessToken,
	basin,
	endpoints,
	batchSize: sessionBatchSize,
	lingerDuration: sessionLingerMs,
	produce: ({ messages }) => createStream(messages),
});

function trackPromise(promise: Promise<unknown>): void {
	const tracked = promise
		.catch((error) => {
			console.error("[tanstack-ai-chat] background persist failed:", error);
		})
		.finally(() => pending.delete(tracked));
	pending.add(tracked);
}

async function snapshotForStream(streamName: string) {
	try {
		return await handler.snapshot(streamName);
	} catch (error) {
		if (isStreamNotFound(error)) {
			return { records: [], nextSeqNum: 0 };
		}
		throw error;
	}
}

async function ensureStreamExists(streamName: string): Promise<void> {
	await basinClient.streams
		.create({ stream: streamName })
		.catch((error: unknown) => {
			if (!(error instanceof S2Error && error.status === 409)) {
				throw error;
			}
		});
}

async function handleSnapshot(chatId: string): Promise<Response> {
	const streamName = streamNameForChat(chatId);
	const snapshot = await snapshotForStream(streamName);
	return Response.json({
		streamName,
		activeRunId: activeRunId(snapshot.records),
		messages: reduceTextMessages(snapshot.records),
		...snapshot,
	});
}

async function handleChat(request: Request): Promise<Response> {
	const body = (await request.json()) as { id?: unknown; message?: unknown };
	if (!isValidChatId(body.id) || !isUserMessage(body.message)) {
		return new Response("Expected { id, message } with a user message.", {
			status: 400,
		});
	}

	const streamName = streamNameForChat(body.id);
	await ensureStreamExists(streamName);
	const snapshot = await snapshotForStream(streamName);
	const messages = [...reduceTextMessages(snapshot.records), body.message];

	return handler.POST(
		new Request(request.url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				streamName,
				sessionId: body.id,
				messages,
			}),
			signal: request.signal,
		}),
		{ waitUntil: trackPromise },
	);
}

function rewriteTailRequest(request: Request, chatId: string): Request {
	const url = new URL(request.url);
	url.searchParams.set("streamName", streamNameForChat(chatId));
	return new Request(url, {
		method: request.method,
		headers: request.headers,
		signal: request.signal,
	});
}

const server = Bun.serve({
	hostname: HOSTNAME,
	port: PORT,
	async fetch(request) {
		try {
			const url = new URL(request.url);

			if (url.pathname === "/" && request.method === "GET") {
				return new Response(Bun.file(join(PUBLIC_DIR, "index.html")), {
					headers: { "Content-Type": "text/html; charset=utf-8" },
				});
			}

			if (url.pathname === "/api/chat" && request.method === "POST") {
				return handleChat(request);
			}

			if (url.pathname === "/api/chat/tail" && request.method === "GET") {
				const chatId = url.searchParams.get("id");
				if (!isValidChatId(chatId)) {
					return new Response("Missing id query parameter", { status: 400 });
				}
				return handler.GET(rewriteTailRequest(request, chatId));
			}

			if (url.pathname === "/api/chat/snapshot" && request.method === "GET") {
				const chatId = url.searchParams.get("id");
				if (!isValidChatId(chatId)) {
					return new Response("Missing id query parameter", { status: 400 });
				}
				return handleSnapshot(chatId);
			}

			return new Response("Not found", { status: 404 });
		} catch (error) {
			console.error("[tanstack-ai-chat] request failed:", error);
			return new Response(
				error instanceof Error ? error.message : String(error),
				{
					status: 500,
					headers: { "Content-Type": "text/plain; charset=utf-8" },
				},
			);
		}
	},
});

console.log(
	`TanStack AI chat example listening on http://${HOSTNAME}:${server.port}`,
);
console.log("Refresh while the fallback stream is typing to test resume.");

process.on("SIGINT", async () => {
	await Promise.allSettled(pending);
	server.stop(true);
	process.exit(0);
});
