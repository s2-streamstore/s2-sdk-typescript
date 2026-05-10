#!/usr/bin/env bun
/**
 * Resumable Anthropic chat. Each chatId maps to two S2 streams:
 *
 * - `${LIVE_PREFIX}-${chatId}`: the durable session log of Anthropic events
 *   (`mode: "session"`); the codec persists it. Replay tails the active turn.
 * - `${USERS_PREFIX}-${chatId}`: an append-only log of user-message text,
 *   one record per turn. Lets us rebuild the full conversation on reload.
 */

import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { AppendInput, AppendRecord, S2 } from "@s2-dev/streamstore";
import { createResumableChat } from "@s2-dev/resumable-stream/anthropic";

const PORT = Number.parseInt(process.env.PORT || "3458", 10);
const PUBLIC_DIR = join(dirname(import.meta.path), "public");
const LIVE_PREFIX =
	process.env.S2_CHAT_LIVE_PREFIX || "anthropic-resumable-chat";
const USERS_PREFIX =
	process.env.S2_CHAT_USERS_PREFIX || "anthropic-resumable-chat-users";
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
const s2 = new S2({ accessToken, endpoints });
const basinClient = s2.basin(basin);
const anthropic = new Anthropic({ apiKey: anthropicKey });

const liveStreamName = (chatId: string) => `${LIVE_PREFIX}-${chatId}`;
const usersStreamName = (chatId: string) => `${USERS_PREFIX}-${chatId}`;

const isValidChatId = (value: unknown): value is string =>
	typeof value === "string" && CHAT_ID_PATTERN.test(value);

const isUserText = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= 2000;

interface ChatPostBody {
	id?: string;
	message?: string;
}

async function readUserMessages(chatId: string): Promise<string[]> {
	const stream = basinClient.stream(usersStreamName(chatId));
	try {
		const session = await stream
			.readSession(
				{ start: { from: { seqNum: 0 }, clamp: true }, stop: { waitSecs: 0 } },
				{ as: "string" },
			)
			.catch(() => null);
		if (!session) return [];
		const out: string[] = [];
		try {
			for await (const record of session) {
				if (record.body) out.push(record.body);
			}
		} finally {
			await session[Symbol.asyncDispose]?.();
		}
		return out;
	} finally {
		await stream.close();
	}
}

async function appendUserMessage(chatId: string, text: string): Promise<void> {
	const stream = basinClient.stream(usersStreamName(chatId));
	try {
		await stream.append(AppendInput.create([AppendRecord.string({ body: text })]));
	} finally {
		await stream.close();
	}
}

async function readAssistantMessages(
	chatId: string,
): Promise<{ messages: Anthropic.Message[]; nextSeqNum?: number }> {
	const res = await chat.history(liveStreamName(chatId));
	return (await res.json()) as {
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

	const [users, { messages: assistants }] = await Promise.all([
		readUserMessages(body.id),
		readAssistantMessages(body.id),
	]);
	await appendUserMessage(body.id, body.message);
	const messages: MessageParam[] = [
		...interleaveForModel(users, assistants),
		{ role: "user", content: body.message },
	];

	const stream = anthropic.messages.stream({
		model: MODEL,
		max_tokens: MAX_TOKENS,
		messages,
	});

	return chat.makeResumable(liveStreamName(body.id), stream, {
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
	const [users, { messages, nextSeqNum }] = await Promise.all([
		readUserMessages(chatId),
		readAssistantMessages(chatId),
	]);
	return Response.json(
		{ users, messages, nextSeqNum },
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
