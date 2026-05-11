#!/usr/bin/env bun
/**
 * Resumable Anthropic chat. Each chatId maps to one S2 stream:
 *
 * - `${LIVE_PREFIX}-${chatId}`: user messages plus Anthropic events.
 *   Replay reads the same records the live UI reads.
 */

import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { createResumableChat } from "@s2-dev/resumable-stream/anthropic";

const PORT = Number.parseInt(process.env.PORT || "3458", 10);
const PUBLIC_DIR = join(dirname(import.meta.path), "public");
const LIVE_PREFIX =
	process.env.S2_CHAT_LIVE_PREFIX || "anthropic-resumable-chat";
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
const endpoints =
	endpointsInit.account || endpointsInit.basin ? endpointsInit : undefined;

const chat = createResumableChat({
	accessToken,
	basin,
	endpoints,
	mode: "session",
});
const anthropic = new Anthropic({ apiKey: anthropicKey });

const liveStreamName = (chatId: string) => `${LIVE_PREFIX}-${chatId}`;

const isValidChatId = (value: unknown): value is string =>
	typeof value === "string" && CHAT_ID_PATTERN.test(value);

const isUserText = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= 2000;

interface ChatPostBody {
	id?: string;
	message?: string;
}

async function readHistory(chatId: string): Promise<{
	users: string[];
	messages: Anthropic.Message[];
	nextSeqNum?: number;
}> {
	const res = await chat.history(liveStreamName(chatId));
	return (await res.json()) as {
		users: string[];
		messages: Anthropic.Message[];
		nextSeqNum?: number;
	};
}

/** Interleaves stored users with reconstructed assistants for the model. */
function interleaveForModel(
	users: string[],
	assistants: Anthropic.Message[],
): MessageParam[] {
	const out: MessageParam[] = [];
	const turns = Math.max(users.length, assistants.length);
	for (let i = 0; i < turns; i += 1) {
		if (i < users.length) out.push({ role: "user", content: users[i]! });
		if (i < assistants.length) {
			out.push({ role: "assistant", content: assistants[i]!.content });
		}
	}
	return out;
}

async function handleChat(req: Request): Promise<Response> {
	const body = (await req.json()) as ChatPostBody;
	if (!isValidChatId(body.id) || !isUserText(body.message)) {
		return new Response(
			"Expected { id, message } with a non-empty user message.",
			{ status: 400 },
		);
	}
	const chatId = body.id;
	const message = body.message;

	const { users, messages: assistants } = await readHistory(chatId);
	const messages: MessageParam[] = [
		...interleaveForModel(users, assistants),
		{ role: "user", content: message },
	];

	const source = (async function* () {
		yield { type: "user_message", message } as const;
		yield* anthropic.messages.stream({
			model: MODEL,
			max_tokens: MAX_TOKENS,
			messages,
		});
	})();

	return chat.makeResumable(liveStreamName(chatId), source, {
		delivery: "replay",
		waitUntil: (promise) =>
			promise.catch((err) => {
				console.error("[example] makeResumable failed:", err);
			}),
	});
}

async function handleReplay(
	chatId: string,
	fromSeqNum?: number,
): Promise<Response> {
	return chat.replay(
		liveStreamName(chatId),
		fromSeqNum !== undefined ? { fromSeqNum } : undefined,
	);
}

async function handleHistory(chatId: string): Promise<Response> {
	return Response.json(
		await readHistory(chatId),
		{ headers: { "Cache-Control": "no-store" } },
	);
}

const corsHeaders = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
} as const;

function withCors(res: Response): Response {
	for (const [k, v] of Object.entries(corsHeaders)) res.headers.set(k, v);
	return res;
}

function parseSeqNum(value: string | null): number | undefined {
	if (value === null) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

const server = Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);

		if (req.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders });
		}

		if (url.pathname === "/api/chat" && req.method === "POST") {
			return withCors(await handleChat(req));
		}

		if (url.pathname === "/api/chat/stream" && req.method === "GET") {
			const chatId = url.searchParams.get("id");
			if (!isValidChatId(chatId)) {
				return new Response("Missing id query parameter", { status: 400 });
			}
			return withCors(
				await handleReplay(chatId, parseSeqNum(url.searchParams.get("from"))),
			);
		}

		if (url.pathname === "/api/chat/history" && req.method === "GET") {
			const chatId = url.searchParams.get("id");
			if (!isValidChatId(chatId)) {
				return new Response("Missing id query parameter", { status: 400 });
			}
			return withCors(await handleHistory(chatId));
		}

		if (url.pathname === "/" || url.pathname === "/index.html") {
			return new Response(Bun.file(join(PUBLIC_DIR, "index.html")));
		}

		const file = Bun.file(join(PUBLIC_DIR, url.pathname));
		if (await file.exists()) return new Response(file);

		return new Response("Not found", { status: 404 });
	},
});

console.log(`Anthropic resumable chat at http://localhost:${server.port}`);
console.log(`Basin: ${basin}, model: ${MODEL}`);
console.log("\nTry refreshing mid-generation to see resumability in action.");
