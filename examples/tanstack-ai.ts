import {
	createS2Connection,
	createS2SessionHandler,
	type StreamChunk,
} from "@s2-dev/resumable-stream/tanstack-ai";

type Importer = (specifier: string) => Promise<any>;
const importOptional: Importer = (specifier) => import(specifier);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function* fallbackStream(prompt: string): AsyncIterable<StreamChunk> {
	const timestamp = Date.now();
	yield { type: "RUN_STARTED", timestamp };
	await sleep(25);
	yield {
		type: "TEXT_MESSAGE_START",
		timestamp: timestamp + 1,
		messageId: "msg-1",
		role: "assistant",
	};
	await sleep(25);
	yield {
		type: "TEXT_MESSAGE_CONTENT",
		timestamp: timestamp + 2,
		messageId: "msg-1",
		delta: `Echo: ${prompt}`,
	};
	await sleep(25);
	yield {
		type: "TEXT_MESSAGE_END",
		timestamp: timestamp + 3,
		messageId: "msg-1",
	};
	yield { type: "RUN_FINISHED", timestamp: timestamp + 4 };
}

async function createStream(
	prompt: string,
): Promise<AsyncIterable<StreamChunk>> {
	if (!process.env.OPENAI_API_KEY) {
		return fallbackStream(prompt);
	}

	const [{ chat }, { openaiText }] = await Promise.all([
		importOptional("@tanstack/ai"),
		importOptional("@tanstack/ai-openai"),
	]).catch(() => {
		throw new Error(
			"Install @tanstack/ai and @tanstack/ai-openai to run this example with a real model, or unset OPENAI_API_KEY to run the local fallback stream.",
		);
	});

	return chat({
		adapter: openaiText(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
		messages: [{ role: "user", content: prompt }],
	}) as AsyncIterable<StreamChunk>;
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Set ${name} before running this example.`);
	}
	return value;
}

function trackPromise(
	pending: Set<Promise<unknown>>,
	promise: Promise<unknown>,
): void {
	const tracked = promise.finally(() => {
		pending.delete(tracked);
	});
	pending.add(tracked);
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

async function main() {
	const accessToken = requireEnv("S2_ACCESS_TOKEN");
	const basin = requireEnv("S2_BASIN");
	const prompt =
		process.argv.slice(2).join(" ") ||
		"Why are S2 streams useful for AI sessions?";
	const streamName =
		process.env.S2_STREAM ??
		`tanstack-ai/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const pending = new Set<Promise<unknown>>();

	const handler = createS2SessionHandler({
		accessToken,
		basin,
		endpoints: endpointsFromEnv(),
		produce: ({ messages }) => {
			const lastMessage = messages.at(-1);
			const content =
				typeof lastMessage?.content === "string" ? lastMessage.content : prompt;
			return createStream(content);
		},
	});

	const server = Bun.serve({
		port: Number(process.env.PORT ?? 0),
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/api/chat/append" && request.method === "POST") {
				return handler.POST(request, {
					waitUntil: (promise) => trackPromise(pending, promise),
				});
			}
			if (url.pathname === "/api/chat/tail" && request.method === "GET") {
				return handler.GET(request);
			}
			if (url.pathname === "/api/chat/snapshot" && request.method === "GET") {
				const name = url.searchParams.get("streamName");
				if (!name) {
					return new Response("Missing streamName", { status: 400 });
				}
				return Response.json(await handler.snapshot(name));
			}
			return new Response("Not found", { status: 404 });
		},
	});

	try {
		const baseUrl = `http://localhost:${server.port}`;
		const connection = createS2Connection({
			appendUrl: `${baseUrl}/api/chat/append`,
			tailUrl: `${baseUrl}/api/chat/tail`,
			streamName,
		});

		console.log("Local TanStack AI example server:", baseUrl);
		console.log("S2 stream:", streamName);
		console.log("Prompt:", prompt);

		const liveChunks: StreamChunk[] = [];
		for await (const chunk of connection.connect(
			[{ role: "user", content: prompt }],
			{ source: "s2-example" },
		)) {
			liveChunks.push(chunk);
			console.log("chunk:", chunk);
		}

		await Promise.all(pending);

		const snapshotResponse = await fetch(
			`${baseUrl}/api/chat/snapshot?streamName=${encodeURIComponent(streamName)}`,
		);
		if (!snapshotResponse.ok) {
			throw new Error(`Snapshot failed: ${snapshotResponse.status}`);
		}
		const snapshot = await snapshotResponse.json();

		console.log("\nLive chunk count:", liveChunks.length);
		console.log("Materialized messages:");
		console.dir(snapshot.messages, { depth: null });
		console.log("Next S2 seqNum:", snapshot.nextSeqNum);
	} finally {
		server.stop(true);
	}
}

await main();
