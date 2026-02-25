#!/usr/bin/env bun

import * as crypto from "node:crypto";
import { dirname, join } from "node:path";
import { openai } from "@ai-sdk/openai";
import {
	AppendRecord,
	BatchTransform,
	Producer,
	S2,
	S2Environment,
	S2Error,
} from "@s2-dev/streamstore";
import {
	type ModelMessage,
	generateText,
	jsonSchema,
	stepCountIs,
	streamText,
	tool,
} from "ai";

const PORT = parseInt(process.env.PORT || "3456", 10);
const PUBLIC_DIR = join(dirname(import.meta.path), "public");

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) throw new Error("Set S2_ACCESS_TOKEN to a valid token.");

const basinName = process.env.S2_BASIN;
if (!basinName) throw new Error("Set S2_BASIN before running this example.");

const MAX_CONTEXT_MESSAGES = Number(
	process.env.AI_SDK_MAX_CONTEXT_MESSAGES ?? 40,
);

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
	retry: { appendRetryPolicy: "all" },
});

const basin = s2.basin(basinName);
const enc = new TextEncoder();
const dec = new TextDecoder();

async function ensureStream(name: string) {
	await basin.streams.create({ stream: name }).catch((err: unknown) => {
		if (!(err instanceof S2Error && err.status === 409)) throw err;
	});
}

function pruneMessages(messages: ModelMessage[]) {
	if (!Number.isFinite(MAX_CONTEXT_MESSAGES) || MAX_CONTEXT_MESSAGES <= 0)
		return;
	const system = messages[0]?.role === "system" ? messages[0] : undefined;
	const start = system ? 1 : 0;
	const nonSystem = messages.slice(start);
	if (nonSystem.length <= MAX_CONTEXT_MESSAGES) return;
	const trimmed = nonSystem.slice(-MAX_CONTEXT_MESSAGES);
	messages.splice(0, messages.length, ...(system ? [system] : []), ...trimmed);
}

type SSEClient = ReadableStreamDefaultController<Uint8Array>;

function sseResponse(clients: Set<SSEClient>): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			clients.add(controller);
		},
		cancel(controller) {
			clients.delete(controller as SSEClient);
		},
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

function broadcast(clients: Set<SSEClient>, event: string, data?: unknown) {
	const payload = data !== undefined ? JSON.stringify(data) : "";
	const msg = `event: ${event}\ndata: ${payload}\n\n`;
	const bytes = enc.encode(msg);
	for (const c of clients) {
		try {
			c.enqueue(bytes);
		} catch {
			clients.delete(c);
		}
	}
}

async function jsonBody(req: Request): Promise<unknown> {
	return req.json();
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

// ── Chat Persistence ─────────────────────────────────────────────────────────

interface StreamRecordInfo {
	seq: number;
	type: string;
	preview: string;
}

const chatClients = new Set<SSEClient>();
const chatMessages: ModelMessage[] = [];
const chatRecords: StreamRecordInfo[] = [];
let chatProducer: Producer;
let chatStream: ReturnType<typeof basin.stream>;
let chatStreamBuffer: Array<{ event: string; data: unknown }> | null = null;

function chatEmit(event: string, data?: unknown) {
	if (chatStreamBuffer !== null) {
		chatStreamBuffer.push({ event, data });
	}
	broadcast(chatClients, event, data);
}

function handleChatEvents(): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			if (chatStreamBuffer !== null) {
				for (const { event, data } of chatStreamBuffer) {
					const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
					try { controller.enqueue(enc.encode(msg)); } catch { return; }
				}
			}
			chatClients.add(controller);
		},
		cancel(controller) {
			chatClients.delete(controller as SSEClient);
		},
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

function messageToRecord(msg: ModelMessage): AppendRecord {
	return AppendRecord.bytes({
		body: enc.encode(JSON.stringify(msg)),
		headers: [[enc.encode("role"), enc.encode(msg.role)]],
	});
}

function recordToMessage(body: Uint8Array): ModelMessage {
	return JSON.parse(dec.decode(body)) as ModelMessage;
}

function messagePreview(msg: ModelMessage): string {
	const text =
		typeof msg.content === "string"
			? msg.content
			: JSON.stringify(msg.content);
	return text.slice(0, 40) + (text.length > 40 ? "..." : "");
}

async function initChat() {
	const streamName = "ai-sdk-demo/chat";
	await ensureStream(streamName);
	chatStream = basin.stream(streamName);
	chatProducer = new Producer(
		new BatchTransform({ lingerDurationMillis: 10 }),
		await chatStream.appendSession(),
	);

	const { tail } = await chatStream.checkTail();
	if (tail.seqNum > 0) {
		let nextSeqNum = 0;
		while (nextSeqNum < tail.seqNum) {
			const batch = await chatStream.read(
				{
					start: { from: { seqNum: nextSeqNum } },
					stop: { limits: { count: 1000 } },
				},
				{ as: "bytes" },
			);
			if (batch.records.length === 0) break;
			for (const record of batch.records) {
				try {
					const msg = recordToMessage(record.body);
					chatMessages.push(msg);
					chatRecords.push({
						seq: record.seqNum,
						type: msg.role,
						preview: messagePreview(msg),
					});
				} catch { /* skip */ }
				nextSeqNum = record.seqNum + 1;
			}
		}
		pruneMessages(chatMessages);
	}
	console.log(`[chat] Restored ${chatMessages.length} messages`);
}

async function handleChatHistory(): Promise<Response> {
	return jsonResponse({
		messages: chatMessages.map((m) => ({
			role: m.role,
			content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
		})),
		records: chatRecords,
	});
}

async function handleChatSend(req: Request): Promise<Response> {
	const { message } = (await jsonBody(req)) as { message: string };

	const userMsg: ModelMessage = { role: "user", content: message };
	chatMessages.push(userMsg);
	pruneMessages(chatMessages);

	const userTicket = await chatProducer.submit(messageToRecord(userMsg));
	const userAck = await userTicket.ack();
	const userRec: StreamRecordInfo = { seq: userAck.seqNum(), type: "user", preview: messagePreview(userMsg) };
	chatRecords.push(userRec);
	broadcast(chatClients, "stream-record", userRec);

	chatStreamBuffer = [];
	chatEmit("assistant-start");

	const result = streamText({ model: openai("gpt-4o-mini"), messages: chatMessages });

	let fullText = "";
	for await (const chunk of result.textStream) {
		fullText += chunk;
		chatEmit("assistant-chunk", chunk);
	}

	const assistantMsg: ModelMessage = { role: "assistant", content: fullText };
	chatMessages.push(assistantMsg);
	pruneMessages(chatMessages);

	const assistantTicket = await chatProducer.submit(messageToRecord(assistantMsg));
	const assistantAck = await assistantTicket.ack();
	const assistantRec: StreamRecordInfo = { seq: assistantAck.seqNum(), type: "assistant", preview: messagePreview(assistantMsg) };
	chatRecords.push(assistantRec);
	chatEmit("stream-record", assistantRec);
	chatEmit("assistant-end");
	chatStreamBuffer = null;

	return jsonResponse({ ok: true });
}

async function handleChatRestart(): Promise<Response> {
	broadcast(chatClients, "restore-start");

	chatMessages.length = 0;
	chatRecords.length = 0;

	await new Promise((r) => setTimeout(r, 500));

	const { tail } = await chatStream.checkTail();
	if (tail.seqNum > 0) {
		let nextSeqNum = 0;
		while (nextSeqNum < tail.seqNum) {
			const batch = await chatStream.read(
				{ start: { from: { seqNum: nextSeqNum } }, stop: { limits: { count: 1000 } } },
				{ as: "bytes" },
			);
			if (batch.records.length === 0) break;
			for (const record of batch.records) {
				try {
					const msg = recordToMessage(record.body);
					chatMessages.push(msg);
					const rec: StreamRecordInfo = { seq: record.seqNum, type: msg.role, preview: messagePreview(msg) };
					chatRecords.push(rec);
					broadcast(chatClients, "restore-message", {
						role: msg.role,
						content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
					});
					broadcast(chatClients, "restore-record", rec);
					await new Promise((r) => setTimeout(r, 80));
				} catch { /* skip */ }
				nextSeqNum = record.seqNum + 1;
			}
		}
		pruneMessages(chatMessages);
	}

	broadcast(chatClients, "restore-end");
	return jsonResponse({ ok: true });
}

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

type AgentRunState = {
	clients: Set<SSEClient>;
	buffer: Array<{ event: string; data: unknown }>;
	done: boolean;
};
const agentRuns = new Map<string, AgentRunState>();

type Token =
	| { type: "number"; value: number }
	| { type: "op"; value: "+" | "-" | "*" | "/" }
	| { type: "paren"; value: "(" | ")" };

function tokenizeExpression(input: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	const isDigit = (ch: string) => ch >= "0" && ch <= "9";
	while (i < input.length) {
		const ch = input[i];
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			i++;
			continue;
		}
		if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
			tokens.push({ type: "op", value: ch });
			i++;
			continue;
		}
		if (ch === "(" || ch === ")") {
			tokens.push({ type: "paren", value: ch });
			i++;
			continue;
		}
		if (isDigit(ch) || ch === ".") {
			const start = i;
			let dotCount = 0;
			while (i < input.length && (isDigit(input[i]) || input[i] === ".")) {
				if (input[i] === ".") dotCount++;
				if (dotCount > 1) throw new Error("Invalid number format");
				i++;
			}
			const raw = input.slice(start, i);
			const value = Number(raw);
			if (!Number.isFinite(value)) throw new Error(`Invalid number: "${raw}"`);
			tokens.push({ type: "number", value });
			continue;
		}
		throw new Error(`Unexpected character: "${ch}"`);
	}
	return tokens;
}

function evaluateExpression(input: string): number {
	const tokens = tokenizeExpression(input);
	let index = 0;
	const peek = () => tokens[index];
	const consume = () => tokens[index++];

	const parseExpression = (): number => {
		let value = parseTerm();
		while (true) {
			const token = peek();
			if (!token || token.type !== "op" || (token.value !== "+" && token.value !== "-"))
				break;
			consume();
			const rhs = parseTerm();
			value = token.value === "+" ? value + rhs : value - rhs;
		}
		return value;
	};

	const parseTerm = (): number => {
		let value = parseFactor();
		while (true) {
			const token = peek();
			if (!token || token.type !== "op" || (token.value !== "*" && token.value !== "/"))
				break;
			consume();
			const rhs = parseFactor();
			value = token.value === "*" ? value * rhs : value / rhs;
		}
		return value;
	};

	const parseFactor = (): number => {
		const token = peek();
		if (!token) throw new Error("Unexpected end of expression");
		if (token.type === "op" && (token.value === "+" || token.value === "-")) {
			consume();
			const value = parseFactor();
			return token.value === "-" ? -value : value;
		}
		if (token.type === "paren" && token.value === "(") {
			consume();
			const value = parseExpression();
			const closing = consume();
			if (!closing || closing.type !== "paren" || closing.value !== ")")
				throw new Error("Expected ')'");
			return value;
		}
		if (token.type === "number") {
			consume();
			return token.value;
		}
		throw new Error("Unexpected token");
	};

	const result = parseExpression();
	if (index < tokens.length) throw new Error("Unexpected extra input");
	return result;
}

const agentTools = {
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
			try {
				const result = evaluateExpression(expression);
				return { expression, result };
			} catch (err) {
				return {
					expression,
					error: err instanceof Error ? err.message : "Invalid expression",
				};
			}
		},
	}),
};

async function handleAgentRun(req: Request): Promise<Response> {
	const { prompt } = (await jsonBody(req)) as { prompt: string };
	const runId = crypto.randomUUID().slice(0, 8);
	const streamName = `ai-sdk-demo/agent/run-${runId}`;

	await ensureStream(streamName);
	const streamClient = basin.stream(streamName);
	const producer = new Producer(
		new BatchTransform({ lingerDurationMillis: 10 }),
		await streamClient.appendSession(),
	);

	const runState: AgentRunState = {
		clients: new Set<SSEClient>(),
		buffer: [],
		done: false,
	};
	agentRuns.set(runId, runState);

	function emit(event: string, data: unknown) {
		runState.buffer.push({ event, data });
		broadcast(runState.clients, event, data);
	}

	async function log(event: AgentEvent) {
		const ticket = await producer.submit(
			AppendRecord.bytes({
				body: enc.encode(JSON.stringify(event)),
				headers: [[enc.encode("type"), enc.encode(event.type)]],
			}),
		);
		const ack = await ticket.ack();
		const rec: StreamRecordInfo = {
			seq: ack.seqNum(),
			type: event.type,
			preview:
				event.type === "step"
					? event.toolCalls.map((tc) => tc.tool).join(", ") || "text"
					: event.type === "run_start"
						? prompt.slice(0, 40)
						: `${(event as { steps: number }).steps} steps`,
		};
		emit("stream-record", rec);
	}

	(async () => {
		try {
			await log({
				type: "run_start",
				prompt,
				timestamp: new Date().toISOString(),
			});

			let stepIndex = 0;

			const result = await generateText({
				model: openai("gpt-4o-mini"),
				tools: agentTools,
				stopWhen: stepCountIs(10),
				prompt,
				onStepFinish: async (step) => {
					stepIndex++;
					const stepEvent: AgentEvent = {
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
					};
					await log(stepEvent);
					emit("step", stepEvent);
				},
			});

			const endEvent: AgentEvent = {
				type: "run_end",
				text: result.text,
				steps: result.steps.length,
				totalTokens: result.usage?.totalTokens ?? 0,
				timestamp: new Date().toISOString(),
			};
			await log(endEvent);
			emit("run-end", endEvent);
			runState.done = true;

			await producer.close();
			await streamClient.close();
		} catch (err) {
			console.error(`[agent] Run ${runId} failed:`, err);
			runState.done = true;
		} finally {
			setTimeout(() => agentRuns.delete(runId), 120_000);
		}
	})();

	return jsonResponse({ runId });
}

function handleAgentEvents(url: URL): Response {
	const runId = url.searchParams.get("run");
	if (!runId) return jsonResponse({ error: "Missing run param" }, 400);

	const runState = agentRuns.get(runId);

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			if (runState) {
				for (const { event, data } of runState.buffer) {
					const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
					try {
						controller.enqueue(enc.encode(msg));
					} catch {
						return;
					}
				}
				if (runState.done) {
					controller.close();
					return;
				}
				runState.clients.add(controller);
			}
		},
		cancel(controller) {
			if (runState) {
				runState.clients.delete(controller as SSEClient);
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

// ── Dinner Party ──────────────────────────────────────────────────────────────

const setting =
	"You find yourself as a guest at a strange dinner. You don't recognize your host, or the other " +
	"guests, but you are all seated around a table. And it seems that a conversation is just starting.";

interface Guest {
	name: string;
	system: string;
}

const guests: Guest[] = [
	{
		name: "Socrates",
		system:
			"You are Socrates, the Athenian philosopher. You ask probing questions " +
			"rather than making assertions. You love conversation and wine. Many think you are " +
			"arrogant. Later, you will be put to death because you annoyed the citizens of " +
			"Athens so much, but that's ok, in some sense you will have won. You speak like Socrates " +
			"as known from Plato's dialogues. Keep your responses to a single sentence, unless you really " +
			"have a very important point to make.",
	},
	{
		name: "Freud",
		system:
			"You are Sigmund Freud, the founder of psychoanalysis. You interpret " +
			"everything through the lens of unconscious desires, repression, and " +
			"the psyche. You are confident, occasionally provocative, and always " +
			"looking for the hidden motivation. Keep responses to 1 sentence unless it is " +
			"really important.",
	},
	{
		name: "Genghis Khan",
		system:
			"You are Genghis Khan, founder of the Mongol Empire. You value strength, " +
			"loyalty, and decisive action. You speak from experience of uniting " +
			"warring tribes and conquering vast territories. You respect merit above " +
			"all else. Your responses are terse, but you are charismatic.",
	},
];

type BusMessage = {
	from: string;
	content: string;
	turn: number;
};

type MemoryRecord =
	| {
			type: "message";
			role: "system" | "user" | "assistant";
			content: string;
			busSeqNum?: number;
	  }
	| {
			type: "reasoning";
			content: string;
			busSeqNum?: number;
	  };

type DinnerGuestState = {
	guest: Guest;
	messages: ModelMessage[];
	lastBusSeqNum: number;
	stream: ReturnType<typeof basin.stream>;
	producer: Producer;
};

const DINNER_PREFIX = "ai-sdk-demo/dinner";
const dinnerClients = new Set<SSEClient>();

let dinnerStarted = false;
let dinnerGuestStates: DinnerGuestState[] = [];
let dinnerBusStream: ReturnType<typeof basin.stream> | null = null;
let dinnerBusProducer: Producer | null = null;
let dinnerTurnNumber = 0;
let dinnerGuestIndex = 0;

interface DinnerMessageInfo {
	from: string;
	content: string;
}
let dinnerMessages: DinnerMessageInfo[] = [];
let dinnerRecords: { seq: number; stream: string; type: string; preview: string }[] = [];

async function initDinnerGuest(guest: Guest): Promise<DinnerGuestState> {
	const streamName = `${DINNER_PREFIX}/guest/${guest.name.toLowerCase().replace(/\s+/g, "-")}`;
	await ensureStream(streamName);
	const stream = basin.stream(streamName);
	const producer = new Producer(
		new BatchTransform({ lingerDurationMillis: 10 }),
		await stream.appendSession(),
	);

	const messages: ModelMessage[] = [];
	let lastBusSeqNum = -1;

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
					const mem = JSON.parse(dec.decode(record.body)) as MemoryRecord;
					if (mem.type !== "reasoning") {
						messages.push({ role: mem.role, content: mem.content });
					}
					if (mem.busSeqNum !== undefined && mem.busSeqNum > lastBusSeqNum) {
						lastBusSeqNum = mem.busSeqNum;
					}
				} catch { /* skip */ }
				nextSeqNum = record.seqNum + 1;
			}
		}
	}

	if (messages.length === 0) {
		const fullSystem = `${guest.system}\n\n${setting}`;
		const systemMsg: ModelMessage = { role: "system", content: fullSystem };
		messages.push(systemMsg);
		const rec: MemoryRecord = { type: "message", role: "system", content: fullSystem };
		const ticket = await producer.submit(
			AppendRecord.bytes({ body: enc.encode(JSON.stringify(rec)) }),
		);
		await ticket.ack();
	}

	pruneMessages(messages);
	return { guest, messages, lastBusSeqNum, stream, producer };
}

async function dinnerPostToBus(msg: BusMessage): Promise<number> {
	const ticket = await dinnerBusProducer!.submit(
		AppendRecord.bytes({
			body: enc.encode(JSON.stringify(msg)),
			headers: [[enc.encode("from"), enc.encode(msg.from)]],
		}),
	);
	const ack = await ticket.ack();
	return ack.seqNum();
}

async function dinnerReadBusAfter(
	afterSeqNum: number,
): Promise<{ msg: BusMessage; seqNum: number }[]> {
	const startSeqNum = afterSeqNum + 1;
	const { tail } = await dinnerBusStream!.checkTail();
	if (startSeqNum >= tail.seqNum) return [];

	const results: { msg: BusMessage; seqNum: number }[] = [];
	let nextSeqNum = startSeqNum;
	while (nextSeqNum < tail.seqNum) {
		const batch = await dinnerBusStream!.read(
			{
				start: { from: { seqNum: nextSeqNum } },
				stop: { limits: { count: 1000 } },
			},
			{ as: "bytes" },
		);
		if (batch.records.length === 0) break;
		for (const record of batch.records) {
			try {
				const msg = JSON.parse(dec.decode(record.body)) as BusMessage;
				results.push({ msg, seqNum: record.seqNum });
			} catch { /* skip */ }
			nextSeqNum = record.seqNum + 1;
		}
	}
	return results;
}

async function dinnerSaveToMemory(
	state: DinnerGuestState,
	role: "user" | "assistant",
	content: string,
	busSeqNum?: number,
) {
	state.messages.push({ role, content });
	pruneMessages(state.messages);
	const rec: MemoryRecord = { type: "message", role, content, busSeqNum };
	const ticket = await state.producer.submit(
		AppendRecord.bytes({ body: enc.encode(JSON.stringify(rec)) }),
	);
	const ack = await ticket.ack();
	if (busSeqNum !== undefined && busSeqNum > state.lastBusSeqNum) {
		state.lastBusSeqNum = busSeqNum;
	}
	broadcast(dinnerClients, "stream-record", {
		seq: ack.seqNum(),
		stream: state.guest.name,
		type: role,
		preview: content.slice(0, 40),
	});
}

async function dinnerSaveReasoning(
	state: DinnerGuestState,
	content: string,
	busSeqNum?: number,
) {
	const rec: MemoryRecord = { type: "reasoning", content, busSeqNum };
	const ticket = await state.producer.submit(
		AppendRecord.bytes({
			body: enc.encode(JSON.stringify(rec)),
			headers: [[enc.encode("type"), enc.encode("reasoning")]],
		}),
	);
	await ticket.ack();
}

async function initDinner() {
	const busStreamName = `${DINNER_PREFIX}/bus`;
	await ensureStream(busStreamName);
	dinnerBusStream = basin.stream(busStreamName);
	dinnerBusProducer = new Producer(
		new BatchTransform({ lingerDurationMillis: 10 }),
		await dinnerBusStream.appendSession(),
	);

	dinnerGuestStates = [];
	for (const guest of guests) {
		const state = await initDinnerGuest(guest);
		dinnerGuestStates.push(state);
	}

	const busState = await dinnerBusStream.checkTail();
	const existingTurns = busState.tail.seqNum;

	if (existingTurns > 0) {
		dinnerStarted = true;
		dinnerTurnNumber = existingTurns;
		dinnerGuestIndex =
			dinnerTurnNumber > 0
				? (dinnerTurnNumber - 1) % dinnerGuestStates.length
				: 0;

		const allBus = await dinnerReadBusAfter(-1);
		for (const { msg } of allBus) {
			dinnerMessages.push({ from: msg.from, content: msg.content });
		}

		for (const state of dinnerGuestStates) {
			const missed = await dinnerReadBusAfter(state.lastBusSeqNum);
			const fromOthers = missed.filter(
				(m) => m.msg.from !== state.guest.name && m.msg.from !== "host",
			);
			for (const { msg, seqNum } of fromOthers) {
				await dinnerSaveToMemory(state, "user", `[${msg.from}]: ${msg.content}`, seqNum);
			}
		}

		console.log(`[dinner] Resumed with ${existingTurns} messages on bus`);
	} else {
		console.log("[dinner] Fresh dinner party");
	}
}

function getNextGuestName(): string {
	return dinnerGuestStates[dinnerGuestIndex]?.guest.name ?? "";
}

async function handleDinnerStart(req: Request): Promise<Response> {
	const { topic } = (await jsonBody(req)) as { topic: string };

	if (dinnerStarted) {
		return jsonResponse({ ok: true, nextGuest: getNextGuestName() });
	}

	const busSeqNum = await dinnerPostToBus({
		from: "host",
		content: topic.trim(),
		turn: dinnerTurnNumber++,
	});

	broadcast(dinnerClients, "stream-record", {
		seq: busSeqNum,
		stream: "bus",
		type: "host",
		preview: topic.trim().slice(0, 40),
	});

	for (const state of dinnerGuestStates) {
		await dinnerSaveToMemory(state, "user", `[Host]: ${topic.trim()}`, busSeqNum);
	}

	dinnerMessages.push({ from: "host", content: topic.trim() });
	broadcast(dinnerClients, "host-message", { content: topic.trim() });

	dinnerStarted = true;
	broadcast(dinnerClients, "started", { nextGuest: getNextGuestName() });

	return jsonResponse({ ok: true, nextGuest: getNextGuestName() });
}

async function handleDinnerAdvance(): Promise<Response> {
	if (!dinnerStarted) {
		return jsonResponse({ error: "Dinner not started" }, 400);
	}

	const state = dinnerGuestStates[dinnerGuestIndex];

	const result = await generateText({
		model: openai("gpt-4o-mini"),
		messages: state.messages,
	});

	const response = result.text;

	const busSeqNum = await dinnerPostToBus({
		from: state.guest.name,
		content: response,
		turn: dinnerTurnNumber++,
	});

	broadcast(dinnerClients, "stream-record", {
		seq: busSeqNum,
		stream: "bus",
		type: state.guest.name,
		preview: response.slice(0, 40),
	});

	if (result.reasoningText) {
		await dinnerSaveReasoning(state, result.reasoningText, busSeqNum);
	}

	await dinnerSaveToMemory(state, "assistant", response, busSeqNum);

	for (const other of dinnerGuestStates) {
		if (other === state) continue;
		await dinnerSaveToMemory(other, "user", `[${state.guest.name}]: ${response}`, busSeqNum);
	}

	dinnerMessages.push({ from: state.guest.name, content: response });

	dinnerGuestIndex = (dinnerGuestIndex + 1) % dinnerGuestStates.length;

	broadcast(dinnerClients, "guest-message", {
		from: state.guest.name,
		content: response,
		nextGuest: getNextGuestName(),
	});

	return jsonResponse({ ok: true, nextGuest: getNextGuestName() });
}

async function handleDinnerHost(req: Request): Promise<Response> {
	if (!dinnerStarted) {
		return jsonResponse({ error: "Dinner not started" }, 400);
	}

	const { message } = (await jsonBody(req)) as { message: string };

	const busSeqNum = await dinnerPostToBus({
		from: "host",
		content: message.trim(),
		turn: dinnerTurnNumber++,
	});

	broadcast(dinnerClients, "stream-record", {
		seq: busSeqNum,
		stream: "bus",
		type: "host",
		preview: message.trim().slice(0, 40),
	});

	for (const state of dinnerGuestStates) {
		await dinnerSaveToMemory(state, "user", `[Host]: ${message.trim()}`, busSeqNum);
	}

	dinnerMessages.push({ from: "host", content: message.trim() });
	broadcast(dinnerClients, "host-message", { content: message.trim() });

	return jsonResponse({ ok: true });
}

function handleDinnerState(): Response {
	return jsonResponse({
		started: dinnerStarted,
		messages: dinnerMessages,
		records: dinnerRecords,
		nextGuest: dinnerStarted ? getNextGuestName() : null,
	});
}

console.log("Initializing demos...");
await initChat();
await initDinner();
console.log("Ready.\n");

const server = Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname;

		if (req.method === "OPTIONS") {
			return new Response(null, {
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type",
				},
			});
		}

		if (path === "/api/chat/history" && req.method === "GET") return handleChatHistory();
		if (path === "/api/chat/send"    && req.method === "POST") return handleChatSend(req);
		if (path === "/api/chat/restart" && req.method === "POST") return handleChatRestart();
		if (path === "/api/chat/events"  && req.method === "GET")  return handleChatEvents();

		if (path === "/api/agent/run"    && req.method === "POST") return handleAgentRun(req);
		if (path === "/api/agent/events" && req.method === "GET")  return handleAgentEvents(url);

		if (path === "/api/dinner/start"   && req.method === "POST") return handleDinnerStart(req);
		if (path === "/api/dinner/advance" && req.method === "POST") return handleDinnerAdvance();
		if (path === "/api/dinner/host"    && req.method === "POST") return handleDinnerHost(req);
		if (path === "/api/dinner/events"  && req.method === "GET")  return sseResponse(dinnerClients);
		if (path === "/api/dinner/state"   && req.method === "GET")  return handleDinnerState();

		const filePath = path === "/" ? "/index.html" : path;
		const fullPath = join(PUBLIC_DIR, filePath);
		const file = Bun.file(fullPath);

		if (await file.exists()) {
			const ext = filePath.split(".").pop();
			const contentType =
				{
					html: "text/html",
					js: "application/javascript",
					css: "text/css",
					json: "application/json",
					png: "image/png",
					svg: "image/svg+xml",
				}[ext || ""] || "application/octet-stream";
			return new Response(file, { headers: { "Content-Type": contentType } });
		}

		return new Response("Not found", { status: 404 });
	},
});

console.log(`Listening on http://localhost:${server.port}`);
