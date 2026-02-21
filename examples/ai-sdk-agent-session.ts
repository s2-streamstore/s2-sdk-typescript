/**
 * Multi-step AI agent with durable session logging on S2.
 *
 * Every agent step — tool calls, tool results, final response — is
 * appended to an S2 stream as it happens. After the run, the full
 * session is replayed from the stream to show the audit trail.
 *
 * Each run creates its own stream, giving you a durable,
 * replayable log of every decision the agent made.
 *
 * Usage:
 *   export S2_ACCESS_TOKEN="..."
 *   export S2_BASIN="my-basin"
 *   export OPENAI_API_KEY="..."
 *   bun run examples/ai-sdk-agent-session.ts ["your prompt here"]
 */

import * as crypto from "node:crypto";
import { openai } from "@ai-sdk/openai";
import {
	AppendRecord,
	BatchTransform,
	Producer,
	S2,
	S2Environment,
	S2Error,
} from "@s2-dev/streamstore";
import { generateText, jsonSchema, stepCountIs, tool } from "ai";

// ---------------------------------------------------------------------------
// Event schema — each record on the stream is one of these.
// ---------------------------------------------------------------------------

type AgentEvent =
	| { type: "run_start"; prompt: string; timestamp: string }
	| {
			type: "step";
			index: number;
			text: string;
			toolCalls: { tool: string; args: unknown }[];
			toolResults: { tool: string; result: unknown }[];
			finishReason: string;
	  }
	| {
			type: "run_end";
			text: string;
			steps: number;
			totalTokens: number;
			timestamp: string;
	  };

// ---------------------------------------------------------------------------
// Tools — a small set of mock tools for demonstration.
// ---------------------------------------------------------------------------

const tools = {
	lookupCompany: tool({
		description: "Look up information about a company by name.",
		inputSchema: jsonSchema<{ name: string }>({
			type: "object",
			properties: {
				name: { type: "string", description: "The company name to look up" },
			},
			required: ["name"],
		}),
		execute: async ({ name }) => {
			const db: Record<string, object> = {
				S2: {
					founded: 2024,
					sector: "Infrastructure",
					hq: "San Francisco",
					description: "Serverless streaming data platform",
				},
				Vercel: {
					founded: 2015,
					sector: "Developer Tools",
					hq: "San Francisco",
					description: "Frontend cloud and Next.js creators",
				},
				Stripe: {
					founded: 2010,
					sector: "Fintech",
					hq: "San Francisco",
					description: "Online payments infrastructure",
				},
			};
			return db[name] ?? { error: `No data found for "${name}"` };
		},
	}),

	calculate: tool({
		description: "Evaluate a mathematical expression and return the result.",
		inputSchema: jsonSchema<{ expression: string }>({
			type: "object",
			properties: {
				expression: {
					type: "string",
					description: "A mathematical expression, e.g. '2024 - 2010'",
				},
			},
			required: ["expression"],
		}),
		execute: async ({ expression }) => {
			const result = new Function(`"use strict"; return (${expression})`)();
			return { expression, result: Number(result) };
		},
	}),
};

// ---------------------------------------------------------------------------
// S2 setup — one stream per agent run.
// ---------------------------------------------------------------------------

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) throw new Error("Set S2_ACCESS_TOKEN to a valid token.");

const basinName = process.env.S2_BASIN;
if (!basinName) throw new Error("Set S2_BASIN before running this example.");

const runId = crypto.randomUUID().slice(0, 8);
const streamName =
	process.env.S2_STREAM ?? `ai-sdk/agent-sessions/run-${runId}`;

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
	retry: { appendRetryPolicy: "all" },
});

const basin = s2.basin(basinName);
await basin.streams.create({ stream: streamName }).catch((err: unknown) => {
	if (!(err instanceof S2Error && err.status === 409)) throw err;
});

const streamClient = basin.stream(streamName);

const producer = new Producer(
	new BatchTransform({ lingerDurationMillis: 10 }),
	await streamClient.appendSession(),
);

// Helper to append a typed event to the session stream.
const enc = new TextEncoder();
async function log(event: AgentEvent) {
	const ticket = await producer.submit(
		AppendRecord.bytes({
			body: enc.encode(JSON.stringify(event)),
			headers: [[enc.encode("type"), enc.encode(event.type)]],
		}),
	);
	await ticket.ack();
}

// ---------------------------------------------------------------------------
// Run the agent
// ---------------------------------------------------------------------------

const prompt =
	process.argv[2] ??
	"Compare the founding years of S2, Vercel, and Stripe. " +
		"Which was founded most recently, and how many years apart are the oldest and newest?";

console.log(`Prompt: ${prompt}`);
console.log(`Session stream: ${streamName}\n`);

await log({
	type: "run_start",
	prompt,
	timestamp: new Date().toISOString(),
});

let stepIndex = 0;

const result = await generateText({
	model: openai("gpt-4o-mini"),
	tools,
	stopWhen: stepCountIs(10),
	prompt,

	onStepFinish: async (step) => {
		stepIndex++;
		console.log(`--- Step ${stepIndex} (${step.finishReason}) ---`);

		for (const tc of step.toolCalls) {
			console.log(`  call  ${tc.toolName}(${JSON.stringify(tc.input)})`);
		}
		for (const tr of step.toolResults) {
			const out = JSON.stringify(tr.output);
			console.log(
				`  result ${tr.toolName} -> ${out.slice(0, 120)}${out.length > 120 ? "..." : ""}`,
			);
		}
		if (step.text) {
			console.log(
				`  text  ${step.text.slice(0, 200)}${step.text.length > 200 ? "..." : ""}`,
			);
		}

		await log({
			type: "step",
			index: stepIndex,
			text: step.text,
			toolCalls: step.toolCalls.map((tc) => ({
				tool: tc.toolName,
				args: tc.input,
			})),
			toolResults: step.toolResults.map((tr) => ({
				tool: tr.toolName,
				result: tr.output,
			})),
			finishReason: step.finishReason,
		});
	},
});

await log({
	type: "run_end",
	text: result.text,
	steps: result.steps.length,
	totalTokens: result.usage?.totalTokens ?? 0,
	timestamp: new Date().toISOString(),
});

console.log(`\n=== Final Response ===\n\n${result.text}`);
console.log(
	`\nCompleted in ${result.steps.length} steps, ${result.usage?.totalTokens ?? 0} tokens.`,
);

await producer.close();

// ---------------------------------------------------------------------------
// Replay the session log from S2
// ---------------------------------------------------------------------------

console.log("\n=== Replaying session from S2 ===\n");

const dec = new TextDecoder();
const { tail } = await streamClient.checkTail();
let nextSeqNum = 0;

while (nextSeqNum < tail.seqNum) {
	const batch = await streamClient.read(
		{
			start: { from: { seqNum: nextSeqNum } },
			stop: { limits: { count: 100 } },
		},
		{ as: "bytes" },
	);
	if (batch.records.length === 0) break;

	for (const record of batch.records) {
		const event = JSON.parse(dec.decode(record.body)) as AgentEvent;
		const summary =
			event.type === "run_start"
				? `prompt="${event.prompt.slice(0, 60)}..."`
				: event.type === "step"
					? `${event.toolCalls.map((tc) => tc.tool).join(", ") || "text"} (${event.finishReason})`
					: `${event.steps} steps, ${event.totalTokens} tokens`;
		console.log(`  [seq ${record.seqNum}] ${event.type}: ${summary}`);
		nextSeqNum = record.seqNum + 1;
	}
}

await streamClient.close();
console.log(
	`\nSession log is durable on stream "${streamName}". Replay it anytime.`,
);
