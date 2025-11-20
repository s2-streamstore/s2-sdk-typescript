import { openai } from "@ai-sdk/openai";
import { S2 } from "@s2-dev/streamstore";
import { streamText } from "ai";
import createDebug from "debug";
import {
	DeserializingReadSession,
	SerializingAppendSession,
} from "../src/patterns/serialization.js";

const debug = createDebug("patterns:examples:ai-sdk");

type AiStreamChunk = {
	conversationId: string;
	index: number;
	role: "assistant";
	content: string;
};

async function main(): Promise<void> {
	const s2AccessToken = process.env.S2_ACCESS_TOKEN;
	if (!s2AccessToken) {
		throw new Error("S2_ACCESS_TOKEN env var is required");
	}

	const basinId = process.env.S2_BASIN ?? "demo-ai-basin";
	const streamId = process.env.S2_STREAM ?? "vercel-ai-stream-0001";

	const s2 = new S2({
		accessToken: s2AccessToken,
		retry: {
			maxAttempts: 10,
			retryBackoffDurationMillis: 100,
			appendRetryPolicy: "all",
		},
	});

	const stream = s2.basin(basinId).stream(streamId);

	const textEncoder = new TextEncoder();
	const textDecoder = new TextDecoder();

	const append = new SerializingAppendSession<AiStreamChunk>(
		await stream.appendSession(),
		(msg) => textEncoder.encode(JSON.stringify(msg)),
		{ dedupeSeq: 0n },
	);

	const conversationId = `conv-${Date.now()}`;

	debug("Requesting streaming completion from Vercel AI SDK...");

	const result = await streamText({
		model: openai("gpt-4o-mini"),
		prompt:
			"You are writing into an append-only log. " +
			"Please give a response of at least 1MiB in length. It is a test of an SDK.",
	});

	let index = 0;

	let [forUI, forS2] = result.textStream
		.pipeThrough(
			new TransformStream<string, AiStreamChunk>({
				transform: (chunk, controller) => {
					controller.enqueue({
						conversationId,
						index: index++,
						role: "assistant",
						content: chunk,
					});
				},
			}),
		)
		.tee();

	let s2Pipe = forS2.pipeTo(append);

	// As chunks arrive from the model, write each one into S2 as a typed message.
	for await (const textPart of forUI) {
		// Write the chunk into S2 (this goes through the full serialization pipeline:
		// serialize -> chunk -> frame -> dedupe -> append).
		// await append.submit(msg);

		// Also show the live stream directly from the model.
		process.stdout.write(textPart.content);
	}

	debug("awaiting s2 durability");
	await s2Pipe;
	debug("stream is durable");

	console.log("\n\nFinished streaming to S2.");
	console.log("Re-reading the same conversation from S2...\n");

	// Read back from S2 and reconstruct the assistant response by joining
	// chunks. We keep read-side dedupe enabled so that if any appends were
	// retried, duplicate records will be filtered out; we then filter by
	// conversationId to scope to this logical conversation.
	const readSession = new DeserializingReadSession<AiStreamChunk>(
		await stream.readSession({
			seq_num: 0,
			as: "bytes",
			bytes: 1024 * 1024 * 100,
		}),
		(buf) => JSON.parse(textDecoder.decode(buf)) as AiStreamChunk,
		{ enableDedupe: true },
	);

	let reconstructed = "";

	for await (const chunk of readSession) {
		if (chunk.conversationId !== conversationId) {
			debug("skipping chunk from other conversation");
			continue;
		}
		reconstructed += chunk.content;
	}

	console.log("=== Reconstructed response from S2 ===\n");
	console.log(reconstructed);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
