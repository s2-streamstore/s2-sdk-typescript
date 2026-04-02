#!/usr/bin/env bun

import { dirname, join } from "node:path";
import { openai } from "@ai-sdk/openai";
import { type ModelMessage, streamText } from "ai";
import { createDurableChat } from "@s2-dev/durable-aisdk";

const PORT = Number.parseInt(process.env.PORT || "3457", 10);
const PUBLIC_DIR = join(dirname(import.meta.path), "public");

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) throw new Error("Set S2_ACCESS_TOKEN");

const basin = process.env.S2_BASIN;
if (!basin) throw new Error("Set S2_BASIN");

const endpointsInit = {
	account: process.env.S2_ACCOUNT_ENDPOINT || undefined,
	basin: process.env.S2_BASIN_ENDPOINT || undefined,
};

const chat = createDurableChat({
	accessToken,
	basin,
	endpoints:
		endpointsInit.account || endpointsInit.basin ? endpointsInit : undefined,
});

const active = new Map<string, string>();

async function handleChat(req: Request): Promise<Response> {
	const { id, messages } = (await req.json()) as {
		id: string;
		messages: ModelMessage[];
	};

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

async function handleReplay(chatId: string): Promise<Response> {
	const streamName = active.get(chatId);
	if (!streamName) return new Response(null, { status: 204 });
	return chat.replay(streamName);
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

		const replayMatch = url.pathname.match(
			/^\/api\/chat\/([^/]+)\/stream$/,
		);
		if (replayMatch && req.method === "GET") {
			const res = await handleReplay(replayMatch[1]!);
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
