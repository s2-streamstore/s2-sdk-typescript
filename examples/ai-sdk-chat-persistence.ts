/**
 * Persist a multi-turn AI SDK conversation on an S2 stream.
 *
 * Each message (user + assistant) is appended as a JSON record.
 * When the process restarts, the conversation is replayed from
 * the stream so the model retains full context.
 *
 * Uses the Producer API for efficient, batched writes.
 *
 * Usage:
 *   export S2_ACCESS_TOKEN="..."
 *   export S2_BASIN="my-basin"
 *   export OPENAI_API_KEY="..."
 *   bun run examples/ai-sdk-chat-persistence.ts
 */

import * as readline from "node:readline";
import { openai } from "@ai-sdk/openai";
import {
	AppendRecord,
	BatchTransform,
	Producer,
	S2,
	S2Environment,
	S2Error,
} from "@s2-dev/streamstore";
import { type CoreMessage, streamText } from "ai";

// ---------------------------------------------------------------------------
// Message <-> S2 Record encoding
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

const MAX_CONTEXT_MESSAGES = Number(
	process.env.AI_SDK_MAX_CONTEXT_MESSAGES ?? 40,
);

function pruneMessages(messages: CoreMessage[]) {
	if (!Number.isFinite(MAX_CONTEXT_MESSAGES) || MAX_CONTEXT_MESSAGES <= 0)
		return;
	const system = messages[0]?.role === "system" ? messages[0] : undefined;
	const start = system ? 1 : 0;
	const nonSystem = messages.slice(start);
	if (nonSystem.length <= MAX_CONTEXT_MESSAGES) return;
	const trimmed = nonSystem.slice(-MAX_CONTEXT_MESSAGES);
	messages.splice(0, messages.length, ...(system ? [system] : []), ...trimmed);
}

function messageToRecord(msg: CoreMessage): AppendRecord {
	return AppendRecord.bytes({
		body: enc.encode(JSON.stringify(msg)),
		headers: [[enc.encode("role"), enc.encode(msg.role)]],
	});
}

function recordToMessage(body: Uint8Array): CoreMessage {
	return JSON.parse(dec.decode(body)) as CoreMessage;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) throw new Error("Set S2_ACCESS_TOKEN to a valid token.");

const basinName = process.env.S2_BASIN;
if (!basinName) throw new Error("Set S2_BASIN before running this example.");

const streamName = process.env.S2_STREAM ?? "ai-sdk/chat";

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
	retry: { appendRetryPolicy: "all" },
});

const basin = s2.basin(basinName);

// Ensure the stream exists (409 = already exists, which is fine).
await basin.streams.create({ stream: streamName }).catch((err: unknown) => {
	if (!(err instanceof S2Error && err.status === 409)) throw err;
});

const stream = basin.stream(streamName);

// ---------------------------------------------------------------------------
// Restore conversation history from S2
// ---------------------------------------------------------------------------

console.log("Loading conversation history from S2...");

const messages: CoreMessage[] = [];
const { tail } = await stream.checkTail();

if (tail.seqNum > 0) {
	let nextSeqNum = 0;
	while (nextSeqNum < tail.seqNum) {
		const batch = await stream.read(
			{
				start: { from: { seqNum: nextSeqNum } },
				stop: { limits: { count: 1000 } },
			},
			{ as: "bytes" },
		);

		if (batch.records.length === 0) break;

		for (const record of batch.records) {
			try {
				messages.push(recordToMessage(record.body));
			} catch {
				// Skip records that aren't valid messages.
			}
			nextSeqNum = record.seqNum + 1;
		}
	}

	const restoredCount = messages.length;
	pruneMessages(messages);
	console.log(`Restored ${restoredCount} messages from a previous session.`);
	if (restoredCount !== messages.length) {
		console.log(`Using the last ${messages.length} messages for context.`);
	}
	console.log();
	for (const msg of messages.slice(-4)) {
		const text =
			typeof msg.content === "string"
				? msg.content
				: JSON.stringify(msg.content);
		const preview = text.slice(0, 100);
		console.log(`  [${msg.role}] ${preview}${text.length > 100 ? "..." : ""}`);
	}
	console.log();
} else {
	console.log("No previous conversation found. Starting fresh.\n");
}

// ---------------------------------------------------------------------------
// Producer for appending messages
// ---------------------------------------------------------------------------

const producer = new Producer(
	new BatchTransform({ lingerDurationMillis: 10 }),
	await stream.appendSession(),
);

// ---------------------------------------------------------------------------
// Chat loop
// ---------------------------------------------------------------------------

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});

const ask = (query: string) =>
	new Promise<string>((resolve) => rl.question(query, resolve));

console.log('Type a message to chat. "exit" to quit.\n');

try {
	while (true) {
		const userInput = await ask("you> ");
		if (userInput.trim().toLowerCase() === "exit") break;
		if (!userInput.trim()) continue;

		// Append the user message.
		const userMsg: CoreMessage = { role: "user", content: userInput };
		messages.push(userMsg);
		pruneMessages(messages);
		const userTicket = await producer.submit(messageToRecord(userMsg));

		// Stream the assistant response.
		process.stdout.write("assistant> ");

		const result = streamText({
			model: openai("gpt-4o-mini"),
			messages,
		});

		let fullText = "";
		for await (const chunk of result.textStream) {
			process.stdout.write(chunk);
			fullText += chunk;
		}
		console.log("\n");

		// Append the assistant message.
		const assistantMsg: CoreMessage = {
			role: "assistant",
			content: fullText,
		};
		messages.push(assistantMsg);
		pruneMessages(messages);
		const assistantTicket = await producer.submit(
			messageToRecord(assistantMsg),
		);

		// Wait for both messages to be durable.
		await Promise.all([userTicket.ack(), assistantTicket.ack()]);
	}
} finally {
	rl.close();
	await producer.close();
	await stream.close();
}

console.log("\nConversation saved. Run again to continue where you left off.");
