#!/usr/bin/env bun

import { dirname, join } from "node:path";
import { openai } from "@ai-sdk/openai";
import { type ModelMessage, streamText } from "ai";
import { createDurableChat } from "@s2-dev/resumable-stream/aisdk";

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

	return chat.persist(streamName, result.toUIMessageStream(), {
		waitUntil: (promise) => {
			promise.catch((err) => {
				console.error("[example] persist failed:", err);
			});
		},
	});
}

async function handleReplay(streamName: string): Promise<Response> {
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

		if (url.pathname === "/api/chat/stream" && req.method === "GET") {
			const streamName = url.searchParams.get("stream");
			if (!streamName) {
				return new Response("Missing stream query parameter", { status: 400 });
			}
			const res = await handleReplay(streamName);
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
