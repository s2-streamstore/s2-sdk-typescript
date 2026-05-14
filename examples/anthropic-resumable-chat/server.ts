#!/usr/bin/env bun
/**
 * Resumable Anthropic chat backed by two S2 streams per chat:
 *
 *   - History stream `${HISTORY_PREFIX}-${chatId}`
 *     Appended via the raw S2 SDK. One record per chat message:
 *       { role: "user",      content: string }
 *       { role: "assistant", content: ContentBlock[] }
 *
 *   - Live stream `${LIVE_PREFIX}-${chatId}-${turnIdx}`
 *     One S2 stream per turn, written via `createResumableChat`.
 *     Stores the raw Anthropic event sequence so the browser can replay
 *     an in-flight turn after F5 / disconnect.
 *
 * Endpoints:
 *   POST /api/chat              { id, message }   → 202
 *   GET  /api/chat/stream?id=                     → SSE (replay active turn) or 204
 *   GET  /api/chat/history?id=                    → { messages: ChatMessage[] }
 */

import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type {
	ContentBlock,
	MessageParam,
	RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import { AppendInput, AppendRecord, S2 } from "@s2-dev/streamstore";
import { createResumableChat } from "@s2-dev/resumable-stream/anthropic";

const PORT = Number.parseInt(process.env.PORT || "3458", 10);
const PUBLIC_DIR = join(dirname(import.meta.path), "public");
const HISTORY_PREFIX =
	process.env.S2_CHAT_HISTORY_PREFIX || "anthropic-chat-history";
const LIVE_PREFIX = process.env.S2_CHAT_LIVE_PREFIX || "anthropic-chat-live";
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

const s2 = new S2({ accessToken, endpoints });
const basinClient = s2.basin(basin);

const chat = createResumableChat({
	accessToken,
	basin,
	endpoints,
	// One fresh stream per turn — single-use mode makes replay close cleanly
	// after the terminal fence.
	mode: "single-use",
});
const anthropic = new Anthropic({ apiKey: anthropicKey });

interface UserMessage {
	role: "user";
	content: string;
}
interface AssistantMessage {
	role: "assistant";
	content: ContentBlock[];
}
type ChatMessage = UserMessage | AssistantMessage;

const historyStreamName = (chatId: string) => `${HISTORY_PREFIX}-${chatId}`;
const liveStreamName = (chatId: string, turnIdx: number) =>
	`${LIVE_PREFIX}-${chatId}-${turnIdx}`;

const isValidChatId = (value: unknown): value is string =>
	typeof value === "string" && CHAT_ID_PATTERN.test(value);

const isUserText = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= 2000;

function isChatMessage(value: unknown): value is ChatMessage {
	if (typeof value !== "object" || value === null) return false;
	const v = value as { role?: unknown; content?: unknown };
	if (v.role === "user") return typeof v.content === "string";
	if (v.role === "assistant") return Array.isArray(v.content);
	return false;
}

async function readHistory(chatId: string): Promise<ChatMessage[]> {
	const stream = basinClient.stream(historyStreamName(chatId));
	try {
		const session = await stream
			.readSession(
				{ start: { from: { seqNum: 0 } }, stop: { waitSecs: 0 } },
				{ as: "string" },
			)
			.catch((err: unknown) => {
				const e = err as { status?: number };
				if (e?.status === 404) return null;
				throw err;
			});
		if (!session) return [];

		const messages: ChatMessage[] = [];
		try {
			for await (const record of session) {
				if (typeof record.body !== "string") continue;
				try {
					const parsed = JSON.parse(record.body);
					if (isChatMessage(parsed)) messages.push(parsed);
				} catch {}
			}
		} finally {
			await session[Symbol.asyncDispose]?.();
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
	const stream = basinClient.stream(historyStreamName(chatId));
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

// History is `[user, assistant, user, assistant, ...]`. A divergence between
// user and assistant counts means the latest user message has no matching
// assistant — that turn is in flight and its index is `userCount - 1`.
function turnIndexForNewTurn(history: ChatMessage[]): number {
	return history.filter((m) => m.role === "user").length;
}

function activeTurnIndex(history: ChatMessage[]): number | null {
	const userCount = history.filter((m) => m.role === "user").length;
	const assistantCount = history.filter((m) => m.role === "assistant").length;
	return userCount > assistantCount ? userCount - 1 : null;
}

// Yields each event through to S2 unchanged while folding content blocks on
// the side. On `message_stop` we append the finished assistant message to the
// history stream so it survives independently of the live stream.
function persistCompletedTurn(
	chatId: string,
	source: AsyncIterable<RawMessageStreamEvent>,
): AsyncIterable<RawMessageStreamEvent> {
	return (async function* () {
		const content: ContentBlock[] = [];
		const jsonBuf = new Map<number, string>();

		for await (const event of source) {
			handleEvent(content, jsonBuf, event);
			if (event.type === "message_stop") {
				await appendHistoryMessage(chatId, { role: "assistant", content });
			}
			yield event;
		}
	})();
}

function handleEvent(
	content: ContentBlock[],
	jsonBuf: Map<number, string>,
	event: RawMessageStreamEvent,
): void {
	if (event.type === "content_block_start") {
		content[event.index] = { ...event.content_block } as ContentBlock;
		if (
			event.content_block.type === "tool_use" ||
			event.content_block.type === "server_tool_use"
		) {
			jsonBuf.set(event.index, "");
		}
		return;
	}
	if (event.type === "content_block_delta") {
		const block = content[event.index];
		if (!block) return;
		const d = event.delta;
		if (d.type === "text_delta" && block.type === "text") {
			block.text = (block.text || "") + d.text;
		} else if (d.type === "input_json_delta") {
			jsonBuf.set(
				event.index,
				(jsonBuf.get(event.index) ?? "") + d.partial_json,
			);
		} else if (d.type === "thinking_delta" && block.type === "thinking") {
			block.thinking = (block.thinking || "") + d.thinking;
		} else if (d.type === "signature_delta" && block.type === "thinking") {
			block.signature = d.signature;
		}
		return;
	}
	if (event.type === "content_block_stop") {
		const buf = jsonBuf.get(event.index);
		const block = content[event.index];
		if (
			buf !== undefined &&
			block &&
			(block.type === "tool_use" || block.type === "server_tool_use")
		) {
			try {
				block.input = buf.length ? JSON.parse(buf) : {};
			} catch {}
		}
		jsonBuf.delete(event.index);
	}
}

function toMessageParams(history: ChatMessage[]): MessageParam[] {
	return history.map((m) =>
		m.role === "user"
			? ({ role: "user", content: m.content } as MessageParam)
			: ({ role: "assistant", content: m.content } as MessageParam),
	);
}

interface ChatPostBody {
	id?: string;
	message?: string;
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
	const userText = body.message;

	const history = await readHistory(chatId);
	const turnIdx = turnIndexForNewTurn(history);

	// Persist before POST returns: `/stream` reads history to find the active turn.
	await appendHistoryMessage(chatId, { role: "user", content: userText });

	const messages: MessageParam[] = [
		...toMessageParams(history),
		{ role: "user", content: userText },
	];
	const source = anthropic.messages.stream({
		model: MODEL,
		max_tokens: MAX_TOKENS,
		messages,
	});

	return chat.makeResumable(
		liveStreamName(chatId, turnIdx),
		persistCompletedTurn(chatId, source),
		{
			delivery: "replay",
			waitUntil: (promise) =>
				promise.catch((err) => {
					console.error("[example] makeResumable failed:", err);
				}),
		},
	);
}

async function handleStream(chatId: string): Promise<Response> {
	const history = await readHistory(chatId);
	const idx = activeTurnIndex(history);
	if (idx === null) {
		return new Response(null, {
			status: 204,
			headers: { "Cache-Control": "no-store" },
		});
	}
	return chat.replay(liveStreamName(chatId, idx));
}

async function handleHistory(chatId: string): Promise<Response> {
	const messages = await readHistory(chatId);
	return Response.json({ messages }, { headers: { "Cache-Control": "no-store" } });
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
				return withCors(
					new Response("Missing id query parameter", { status: 400 }),
				);
			}
			return withCors(await handleStream(chatId));
		}

		if (url.pathname === "/api/chat/history" && req.method === "GET") {
			const chatId = url.searchParams.get("id");
			if (!isValidChatId(chatId)) {
				return withCors(
					new Response("Missing id query parameter", { status: 400 }),
				);
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
