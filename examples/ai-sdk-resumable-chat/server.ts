#!/usr/bin/env bun

/**
 * Resumable AI chat — S2 + AI SDK transport example.
 *
 * A minimal chat server that persists every generation to S2. The browser
 * reads chunks **directly from S2 over SSE** — if you refresh mid-stream
 * the UI picks up right where it left off.
 *
 * Works with both S2 Cloud and s2-lite (local).
 *
 *   ┌──────────┐   POST /api/chat    ┌──────────┐
 *   │ Browser  │ ──────────────────►  │  Server  │
 *   │          │  ◄─ { stream: id }   │   (Bun)  │
 *   └────┬─────┘                      └────┬─────┘
 *        │                                 │
 *        │  SSE: GET .../records?seq_num=0  │  appendSession
 *        │◄──────────────────────── S2  ◄──┘
 *        │      (direct, no proxy)
 *
 * ── S2 Cloud ────────────────────────────────────────────────────
 *   export S2_ACCESS_TOKEN="..."
 *   export S2_BASIN="my-basin"          # createStreamOnAppend enabled
 *   export OPENAI_API_KEY="..."
 *   bun run examples/ai-sdk-resumable-chat/server.ts
 *
 * ── s2-lite (local) ─────────────────────────────────────────────
 *   # terminal 1 — start s2-lite
 *   cargo run -p s2-cli -- lite --port 4000
 *
 *   # terminal 2 — create a basin, then run this example
 *   export S2_ACCOUNT_ENDPOINT="http://localhost:4000"
 *   export S2_BASIN_ENDPOINT="http://localhost:4000"
 *   export S2_ACCESS_TOKEN="ignored"
 *   s2 create-basin my-basin --create-stream-on-append
 *   export S2_BASIN="my-basin"
 *   export OPENAI_API_KEY="..."
 *   bun run examples/ai-sdk-resumable-chat/server.ts
 *
 * Then open http://localhost:3457
 */

import { dirname, join } from "node:path";
import { openai } from "@ai-sdk/openai";
import { S2Endpoints } from "@s2-dev/streamstore";
import { type ModelMessage, streamText } from "ai";
import { createS2ChatPersistence } from "@s2-dev/aisdk-durability";

// ── Config ───────────────────────────────────────────────────────────────────

const PORT = Number.parseInt(process.env.PORT || "3457", 10);
const PUBLIC_DIR = join(dirname(import.meta.path), "public");

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) throw new Error("Set S2_ACCESS_TOKEN");

const basin = process.env.S2_BASIN;
if (!basin) throw new Error("Set S2_BASIN");

// Build an S2EndpointsInit from env vars (raw strings, not class instances).
// This avoids class-identity issues when Bun mixes source and dist imports.
const endpointsInit = {
	account: process.env.S2_ACCOUNT_ENDPOINT || undefined,
	basin: process.env.S2_BASIN_ENDPOINT || undefined,
};
const endpoints = new S2Endpoints(
	endpointsInit.account || endpointsInit.basin ? endpointsInit : undefined,
);

const chat = createS2ChatPersistence({
	accessToken,
	basin,
	endpoints: endpointsInit.account || endpointsInit.basin
		? endpointsInit
		: undefined,
});

// Resolve the base URL the browser will use for direct S2 SSE reads.
// - s2-lite:  http://localhost:4000/v1  (no {basin} in host)
// - S2 Cloud: https://my-basin.b.s2.dev/v1
const s2BaseUrl = endpoints.basinBaseUrl(basin);

// Track active generation per chat so the reconnect endpoint knows the stream.
const active = new Map<string, string>();

// ── Routes ───────────────────────────────────────────────────────────────────

async function handleChat(req: Request): Promise<Response> {
	const { id, messages } = (await req.json()) as {
		id: string;
		messages: ModelMessage[];
	};

	// Unique per generation — the chat ID is reused across refreshes but each
	// generation gets its own S2 stream so fencing tokens don't collide.
	const streamName = `resumable-chat-${id}-${Date.now()}`;

	const result = streamText({
		model: openai("gpt-4o-mini"),
		messages,
	});

	active.set(id, streamName);

	const waitUntil = (p: Promise<unknown>) => {
		p.finally(() => active.delete(id));
	};

	return chat.persist(streamName, result.fullStream, { waitUntil });
}

function handleReconnect(chatId: string): Response {
	const streamName = active.get(chatId);
	if (!streamName) return new Response(null, { status: 204 });
	return Response.json({ stream: streamName });
}

// ── Server ───────────────────────────────────────────────────────────────────

const server = Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);

		if (req.method === "OPTIONS") {
			return new Response(null, {
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type, Authorization",
				},
			});
		}

		if (url.pathname === "/api/chat" && req.method === "POST") {
			const res = await handleChat(req);
			res.headers.set("Access-Control-Allow-Origin", "*");
			return res;
		}

		const reconnectMatch = url.pathname.match(
			/^\/api\/chat\/([^/]+)\/stream$/,
		);
		if (reconnectMatch && req.method === "GET") {
			const res = handleReconnect(reconnectMatch[1]!);
			res.headers.set("Access-Control-Allow-Origin", "*");
			return res;
		}

		// Serve index.html with config injected
		if (url.pathname === "/" || url.pathname === "/index.html") {
			let html = await Bun.file(join(PUBLIC_DIR, "index.html")).text();
			html = html
				.replace("%%S2_TOKEN%%", accessToken)
				.replace("%%S2_BASIN%%", basin)
				.replace("%%S2_BASE_URL%%", s2BaseUrl);
			return new Response(html, {
				headers: { "Content-Type": "text/html" },
			});
		}
		const filePath = join(PUBLIC_DIR, url.pathname);
		const file = Bun.file(filePath);
		if (await file.exists()) return new Response(file);

		return new Response("Not found", { status: 404 });
	},
});

console.log(`Resumable chat running at http://localhost:${server.port}`);
console.log(`Basin: ${basin}`);
console.log(`S2 read endpoint: ${s2BaseUrl}`);
console.log();
console.log("The browser reads AI chunks directly from S2 over SSE.");
console.log("Try refreshing mid-generation to see resumability in action.");
