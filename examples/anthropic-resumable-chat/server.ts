#!/usr/bin/env bun
/**
 * Resumable Anthropic chat: every chatId maps to one durable S2 stream
 * (`mode: "session"`). Each user turn appends `RawMessageStreamEvent`s for
 * one `client.messages.stream(...)` run. Replay tails the active turn;
 * `chat.history()` returns prior closed turns as Anthropic `Message[]`.
 */

import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { createResumableChat } from "@s2-dev/resumable-stream/anthropic";

const PORT = Number.parseInt(process.env.PORT || "3458", 10);
const PUBLIC_DIR = join(dirname(import.meta.path), "public");
const STREAM_PREFIX =
	process.env.S2_CHAT_STREAM_PREFIX || "anthropic-resumable-chat";
const CHAT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const MAX_TOKENS = Number.parseInt(process.env.ANTHROPIC_MAX_TOKENS || "1024", 10);

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) throw new Error("Set S2_ACCESS_TOKEN");
const basin = process.env.S2_BASIN;
if (!basin) throw new Error("Set S2_BASIN");
const anthropicKey = process.env.ANTHROPIC_API_KEY;
if (!anthropicKey) throw new Error("Set ANTHROPIC_API_KEY");

const endpointsInit = {
	account: process.env.S2_ACCOUNT_ENDPOINT || undefined,
	basin: process.env.S2_BASIN_ENDPOINT || undefined,
};

const chat = createResumableChat({
	accessToken,
	basin,
	endpoints:
		endpointsInit.account || endpointsInit.basin ? endpointsInit : undefined,
	mode: "session",
});

const anthropic = new Anthropic({ apiKey: anthropicKey });

function streamName(chatId: string): string {
	return `${STREAM_PREFIX}-${chatId}`;
}

function isValidChatId(value: unknown): value is string {
	return typeof value === "string" && CHAT_ID_PATTERN.test(value);
}

function isUserText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 2000;
}

interface ChatPostBody {
	id?: string;
	message?: string;
}

async function buildModelHistory(chatId: string): Promise<MessageParam[]> {
	const res = await chat.history(streamName(chatId));
	const json = (await res.json()) as { messages: Anthropic.Message[] };
	const out: MessageParam[] = [];
	for (const m of json.messages) {
		// Each closed turn appears as one assistant Message. We don't have the
		// user side stored in S2 (we'd need a side-channel to persist them);
		// for the demo, the client supplies the live user turn, and prior
		// assistants are reconstructed from S2. Real apps should persist user
		// messages too — see README.
		out.push({ role: "assistant", content: m.content });
	}
	return out;
}

async function handleChat(req: Request): Promise<Response> {
	const body = (await req.json()) as ChatPostBody;
	if (!isValidChatId(body.id) || !isUserText(body.message)) {
		return new Response("Expected { id, message } with a non-empty user message.", {
			status: 400,
		});
	}

	const priorMessages = await buildModelHistory(body.id);
	const messages: MessageParam[] = [
		...priorMessages,
		{ role: "user", content: body.message },
	];

	const stream = anthropic.messages.stream({
		model: MODEL,
		max_tokens: MAX_TOKENS,
		messages,
	});

	return chat.makeResumable(streamName(body.id), stream, {
		waitUntil: (promise) => {
			promise.catch((err) => {
				console.error("[example] makeResumable failed:", err);
			});
		},
	});
}

async function handleReplay(
	chatId: string,
	fromSeqNum?: number,
): Promise<Response> {
	return chat.replay(
		streamName(chatId),
		fromSeqNum !== undefined ? { fromSeqNum } : undefined,
	);
}

async function handleHistory(chatId: string): Promise<Response> {
	return chat.history(streamName(chatId));
}

const corsHeaders = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

const server = Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);

		if (req.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders });
		}

		if (url.pathname === "/api/chat" && req.method === "POST") {
			const res = await handleChat(req);
			for (const [k, v] of Object.entries(corsHeaders)) res.headers.set(k, v);
			return res;
		}

		if (url.pathname === "/api/chat/stream" && req.method === "GET") {
			const chatId = url.searchParams.get("id");
			if (!isValidChatId(chatId)) {
				return new Response("Missing id query parameter", { status: 400 });
			}
			const fromParam = url.searchParams.get("from");
			let fromSeqNum: number | undefined;
			if (fromParam !== null) {
				const parsed = Number.parseInt(fromParam, 10);
				if (Number.isSafeInteger(parsed) && parsed >= 0) fromSeqNum = parsed;
			}
			const res = await handleReplay(chatId, fromSeqNum);
			for (const [k, v] of Object.entries(corsHeaders)) res.headers.set(k, v);
			return res;
		}

		if (url.pathname === "/api/chat/history" && req.method === "GET") {
			const chatId = url.searchParams.get("id");
			if (!isValidChatId(chatId)) {
				return new Response("Missing id query parameter", { status: 400 });
			}
			const res = await handleHistory(chatId);
			for (const [k, v] of Object.entries(corsHeaders)) res.headers.set(k, v);
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

console.log(`Anthropic resumable chat at http://localhost:${server.port}`);
console.log(`Basin: ${basin}, model: ${MODEL}`);
console.log("\nTry refreshing mid-generation to see resumability in action.");
