#!/usr/bin/env bun

import { dirname, join } from "node:path";
import { openai } from "@ai-sdk/openai";
import { type UIMessageChunk, streamText } from "ai";
import {
	AppendInput,
	AppendRecord,
	S2,
	S2Error,
} from "@s2-dev/streamstore";
import { createDurableChat } from "@s2-dev/resumable-stream/aisdk";

const PORT = Number.parseInt(process.env.PORT || "3457", 10);
const PUBLIC_DIR = join(dirname(import.meta.path), "public");
const HISTORY_STREAM_PREFIX =
	process.env.S2_CHAT_HISTORY_PREFIX || "resumable-chat-history";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) throw new Error("Set S2_ACCESS_TOKEN");

const basin = process.env.S2_BASIN;
if (!basin) throw new Error("Set S2_BASIN");

const endpointsInit = {
	account: process.env.S2_ACCOUNT_ENDPOINT || undefined,
	basin: process.env.S2_BASIN_ENDPOINT || undefined,
};

type ChatMessage = {
	role: "user" | "assistant";
	content: string;
};

const s2 = new S2({
	accessToken,
	endpoints:
		endpointsInit.account || endpointsInit.basin ? endpointsInit : undefined,
});

const basinClient = s2.basin(basin);

const chat = createDurableChat({
	accessToken,
	basin,
	endpoints:
		endpointsInit.account || endpointsInit.basin ? endpointsInit : undefined,
});

function historyStreamName(chatId: string): string {
	return `${HISTORY_STREAM_PREFIX}-${chatId}`;
}

function isChatMessage(value: unknown): value is ChatMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { role?: unknown }).role !== undefined &&
		((value as { role?: unknown }).role === "user" ||
			(value as { role?: unknown }).role === "assistant") &&
		typeof (value as { content?: unknown }).content === "string"
	);
}

async function ensureStreamExists(streamName: string): Promise<void> {
	await basinClient.streams.create({ stream: streamName }).catch((err: unknown) => {
		if (!(err instanceof S2Error && err.status === 409)) throw err;
	});
}

async function readHistory(chatId: string): Promise<ChatMessage[]> {
	const streamName = historyStreamName(chatId);
	await ensureStreamExists(streamName);

	const stream = basinClient.stream(streamName);
	try {
		const messages: ChatMessage[] = [];
		const session = await stream.readSession(
			{
				start: { from: { seqNum: 0 } },
				stop: { waitSecs: 0 },
			},
			{ as: "string" },
		);

		for await (const record of session) {
			if (typeof record.body === "string") {
				try {
					const message = JSON.parse(record.body);
					if (isChatMessage(message)) {
						messages.push(message);
					}
				} catch {
					// Ignore malformed history records.
				}
			}
		}

		return messages;
	} finally {
		await stream.close();
	}
}

async function appendHistoryMessage(
	chatId: string,
	message: ChatMessage,
): Promise<void> {
	const streamName = historyStreamName(chatId);
	await ensureStreamExists(streamName);

	const stream = basinClient.stream(streamName);
	try {
		await stream.append(
			AppendInput.create([
				AppendRecord.string({ body: JSON.stringify(message) }),
			]),
		);
	} finally {
		await stream.close();
	}
}

function persistCompletedAssistantMessage(
	chatId: string,
	source: AsyncIterable<UIMessageChunk>,
): AsyncIterable<UIMessageChunk> {
	let fullText = "";
	let persisted = false;

	return (async function* () {
		for await (const chunk of source) {
			if (chunk.type === "text-delta") {
				fullText += chunk.delta;
			}

			if (chunk.type === "finish" && !persisted) {
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

async function handleChat(req: Request): Promise<Response> {
	const { id, message } = (await req.json()) as {
		id?: string;
		message?: ChatMessage;
	};

	if (!id || !isChatMessage(message) || message.role !== "user") {
		return new Response("Expected { id, message } with a user message.", {
			status: 400,
		});
	}

	const history = await readHistory(id);
	await appendHistoryMessage(id, message);

	const streamName = `resumable-chat-${id}-${Date.now()}`;

	const result = streamText({
		model: openai("gpt-4o-mini"),
		messages: [...history, message],
	});

	return chat.persist(
		streamName,
		persistCompletedAssistantMessage(id, result.toUIMessageStream()),
		{
			waitUntil: (promise) => {
				promise.catch((err) => {
					console.error("[example] persist failed:", err);
				});
			},
		},
	);
}

async function handleReplay(streamName: string): Promise<Response> {
	return chat.replay(streamName);
}

async function handleHistory(chatId: string): Promise<Response> {
	return Response.json(
		{ messages: await readHistory(chatId) },
		{ headers: { "Cache-Control": "no-store" } },
	);
}

const server = Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);

		if (req.method === "OPTIONS") {
			return new Response(null, {
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type",
				},
			});
		}

		if (url.pathname === "/api/chat" && req.method === "POST") {
			const res = await handleChat(req);
			res.headers.set("Access-Control-Allow-Origin", "*");
			return res;
		}

		if (url.pathname === "/api/chat/stream" && req.method === "GET") {
			const streamName = url.searchParams.get("stream");
			if (!streamName) {
				return new Response("Missing stream query parameter", { status: 400 });
			}
			const res = await handleReplay(streamName);
			res.headers.set("Access-Control-Allow-Origin", "*");
			return res;
		}

		if (url.pathname === "/api/chat/history" && req.method === "GET") {
			const chatId = url.searchParams.get("id");
			if (!chatId) {
				return new Response("Missing id query parameter", { status: 400 });
			}
			const res = await handleHistory(chatId);
			res.headers.set("Access-Control-Allow-Origin", "*");
			return res;
		}

		if (url.pathname === "/" || url.pathname === "/index.html") {
			return new Response(Bun.file(join(PUBLIC_DIR, "index.html")));
		}
		const filePath = join(PUBLIC_DIR, url.pathname);
		const file = Bun.file(filePath);
		if (await file.exists()) return new Response(file);

		return new Response("Not found", { status: 404 });
	},
});

console.log(`Resumable chat running at http://localhost:${server.port}`);
console.log(`Basin: ${basin}`);
console.log();
console.log("Try refreshing mid-generation to see resumability in action.");
