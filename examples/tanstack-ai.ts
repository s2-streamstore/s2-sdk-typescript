import {
	createResumableChat,
	type StreamChunk,
} from "@s2-dev/resumable-stream/tanstack-ai";
import { S2, S2Error } from "@s2-dev/streamstore";

type Importer = (specifier: string) => Promise<any>;
const importOptional: Importer = (specifier) => import(specifier);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function* fallbackStream(prompt: string): AsyncIterable<StreamChunk> {
	const ts = Date.now();
	yield { type: "RUN_STARTED", timestamp: ts };
	await sleep(25);
	yield {
		type: "TEXT_MESSAGE_START",
		timestamp: ts + 1,
		messageId: "msg-1",
		role: "assistant",
	};
	await sleep(25);
	yield {
		type: "TEXT_MESSAGE_CONTENT",
		timestamp: ts + 2,
		messageId: "msg-1",
		delta: `Echo: ${prompt}`,
	};
	await sleep(25);
	yield {
		type: "TEXT_MESSAGE_END",
		timestamp: ts + 3,
		messageId: "msg-1",
	};
	yield { type: "RUN_FINISHED", timestamp: ts + 4 };
}

async function createSource(
	prompt: string,
): Promise<AsyncIterable<StreamChunk>> {
	if (!process.env.OPENAI_API_KEY) return fallbackStream(prompt);

	const [{ chat }, { openaiText }] = await Promise.all([
		importOptional("@tanstack/ai"),
		importOptional("@tanstack/ai-openai"),
	]).catch(() => {
		throw new Error(
			"Install @tanstack/ai and @tanstack/ai-openai to run with a real model, or unset OPENAI_API_KEY.",
		);
	});

	return chat({
		adapter: openaiText(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
		messages: [{ role: "user", content: prompt }],
	}) as AsyncIterable<StreamChunk>;
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Set ${name} before running this example.`);
	return value;
}

function endpointsFromEnv() {
	const account = process.env.S2_ACCOUNT_ENDPOINT;
	const basin = process.env.S2_BASIN_ENDPOINT;
	return account || basin
		? { account: account || undefined, basin: basin || undefined }
		: undefined;
}

async function ensureStreamExists({
	accessToken,
	basin,
	stream,
}: {
	accessToken: string;
	basin: string;
	stream: string;
}): Promise<void> {
	const s2 = new S2({ accessToken, endpoints: endpointsFromEnv() });
	await s2
		.basin(basin)
		.streams.create({ stream })
		.catch((error: unknown) => {
			if (!(error instanceof S2Error && error.status === 409)) {
				throw error;
			}
		});
}

async function* readSse(response: Response): AsyncIterable<StreamChunk> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			const frames = buffer.split(/\r?\n\r?\n/);
			buffer = frames.pop() ?? "";
			for (const frame of frames) {
				const data = frame
					.split(/\r?\n/)
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n");
				if (!data || data === "[DONE]") continue;
				yield JSON.parse(data) as StreamChunk;
			}
			if (done) break;
		}
	} finally {
		reader.releaseLock();
	}
}

async function main() {
	const accessToken = requireEnv("S2_ACCESS_TOKEN");
	const basin = requireEnv("S2_BASIN");
	const prompt =
		process.argv.slice(2).join(" ") ||
		"Why are S2 streams useful for AI sessions?";
	const streamName =
		process.env.S2_STREAM ??
		`tanstack-ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

	const chat = createResumableChat({
		accessToken,
		basin,
		endpoints: endpointsFromEnv(),
		mode: "single-use",
	});

	const source = await createSource(prompt);
	const pending = new Set<Promise<unknown>>();
	const trackPromise = (p: Promise<unknown>) => {
		const tracked = p.finally(() => pending.delete(tracked));
		pending.add(tracked);
	};

	console.log("S2 stream:", streamName);
	console.log("Prompt:", prompt);

	await ensureStreamExists({ accessToken, basin, stream: streamName });
	const response = await chat.makeResumable(streamName, source, {
		waitUntil: trackPromise,
	});
	if (!response.ok) {
		throw new Error(`makeResumable failed: ${response.status}`);
	}

	const chunks: StreamChunk[] = [];
	for await (const chunk of readSse(response)) {
		chunks.push(chunk);
		console.log("chunk:", chunk);
	}

	await Promise.all(pending);
	console.log("\nLive chunk count:", chunks.length);
}

await main();
