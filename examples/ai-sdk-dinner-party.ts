/**
 * "Dinner Party" — multi-agent conversation powered by S2 streams.
 *
 * N guests (each an LLM with a distinct persona) sit around a table
 * and discuss a topic chosen by the user. Every guest has their own
 * S2 stream (private working memory) and they communicate through a
 * shared bus stream.
 *
 * The conversation is fully resumable: Ctrl-C to leave, run again
 * to pick up exactly where everyone left off.
 *
 * Architecture:
 *   dinner-party/bus          — shared message bus (all public messages)
 *   dinner-party/guest/NAME   — per-guest LLM context (working memory)
 *
 * Usage:
 *   export S2_ACCESS_TOKEN="..."
 *   export S2_BASIN="my-basin"
 *   export OPENAI_API_KEY="..."
 *   bun run examples/ai-sdk-dinner-party.ts ["topic to discuss"]
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
import { type CoreMessage, generateText } from "ai";

// ---------------------------------------------------------------------------
// Guest definitions — swap these to change the cast!
// ---------------------------------------------------------------------------

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
			"have a very important point to make."
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A message on the shared bus. */
type BusMessage = {
	from: string;
	content: string;
	turn: number;
};

/** A record on a guest's private memory stream. */
type MemoryRecord = {
	role: "system" | "user" | "assistant";
	content: string;
	/** Bus seqNum this record corresponds to (absent for system prompt). */
	busSeqNum?: number;
};

// ---------------------------------------------------------------------------
// S2 setup
// ---------------------------------------------------------------------------

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) throw new Error("Set S2_ACCESS_TOKEN to a valid token.");

const basinName = process.env.S2_BASIN;
if (!basinName) throw new Error("Set S2_BASIN before running this example.");

const prefix = process.env.S2_STREAM_PREFIX ?? "dinner-party";

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

// ---------------------------------------------------------------------------
// Per-guest agent state
// ---------------------------------------------------------------------------

type GuestState = {
	guest: Guest;
	/** Full LLM messages array (system + user/assistant turns). */
	messages: CoreMessage[];
	/** Bus seqNum of the last message this guest has seen. */
	lastBusSeqNum: number;
	/** S2 stream client for this guest's memory. */
	stream: ReturnType<ReturnType<typeof s2.basin>["stream"]>;
	/** Producer for writing to this guest's memory stream. */
	producer: Producer;
};

async function createGuestState(guest: Guest): Promise<GuestState> {
	const streamName = `${prefix}/guest/${guest.name.toLowerCase().replace(/\s+/g, "-")}`;
	await ensureStream(streamName);
	const stream = basin.stream(streamName);

	const producer = new Producer(
		new BatchTransform({ lingerDurationMillis: 10 }),
		await stream.appendSession(),
	);

	// Restore from the guest's memory stream.
	const messages: CoreMessage[] = [];
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
					messages.push({ role: mem.role, content: mem.content });
					if (mem.busSeqNum !== undefined && mem.busSeqNum > lastBusSeqNum) {
						lastBusSeqNum = mem.busSeqNum;
					}
				} catch {
					// skip invalid records
				}
				nextSeqNum = record.seqNum + 1;
			}
		}
	}

	// If fresh start, write the system prompt.
	if (messages.length === 0) {
		const systemMsg: CoreMessage = { role: "system", content: guest.system };
		messages.push(systemMsg);
		const rec: MemoryRecord = { role: "system", content: guest.system };
		const ticket = await producer.submit(
			AppendRecord.bytes({ body: enc.encode(JSON.stringify(rec)) }),
		);
		await ticket.ack();
	}

	return { guest, messages, lastBusSeqNum, stream, producer };
}

// ---------------------------------------------------------------------------
// Shared bus helpers
// ---------------------------------------------------------------------------

const busStreamName = `${prefix}/bus`;
await ensureStream(busStreamName);
const busStream = basin.stream(busStreamName);

const busProducer = new Producer(
	new BatchTransform({ lingerDurationMillis: 10 }),
	await busStream.appendSession(),
);

/** Append a message to the shared bus. Returns the bus seqNum. */
async function postToBus(msg: BusMessage): Promise<number> {
	const ticket = await busProducer.submit(
		AppendRecord.bytes({
			body: enc.encode(JSON.stringify(msg)),
			headers: [[enc.encode("from"), enc.encode(msg.from)]],
		}),
	);
	const ack = await ticket.ack();
	return ack.seqNum();
}

/** Read bus messages after a given seqNum. Returns messages + their seqNums. */
async function readBusAfter(
	afterSeqNum: number,
): Promise<{ msg: BusMessage; seqNum: number }[]> {
	const startSeqNum = afterSeqNum + 1;
	const { tail } = await busStream.checkTail();
	if (startSeqNum >= tail.seqNum) return [];

	const results: { msg: BusMessage; seqNum: number }[] = [];
	let nextSeqNum = startSeqNum;

	while (nextSeqNum < tail.seqNum) {
		const batch = await busStream.read(
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
			} catch {
				// skip invalid records
			}
			nextSeqNum = record.seqNum + 1;
		}
	}

	return results;
}

/** Save a message to the guest's memory stream and update local state. */
async function saveToMemory(
	state: GuestState,
	role: "user" | "assistant",
	content: string,
	busSeqNum?: number,
) {
	state.messages.push({ role, content });
	const rec: MemoryRecord = { role, content, busSeqNum };
	const ticket = await state.producer.submit(
		AppendRecord.bytes({ body: enc.encode(JSON.stringify(rec)) }),
	);
	await ticket.ack();
	if (busSeqNum !== undefined && busSeqNum > state.lastBusSeqNum) {
		state.lastBusSeqNum = busSeqNum;
	}
}

// ---------------------------------------------------------------------------
// Restore / initialize guests
// ---------------------------------------------------------------------------

console.log("Setting the table...\n");

const guestStates: GuestState[] = [];
for (const guest of guests) {
	const state = await createGuestState(guest);
	const msgCount = state.messages.length - 1; // exclude system prompt
	if (msgCount > 0) {
		console.log(`  ${guest.name}: restored ${msgCount} messages from memory`);
	} else {
		console.log(`  ${guest.name}: seated (fresh start)`);
	}
	guestStates.push(state);
}

// Check existing bus state.
const busState = await busStream.checkTail();
const existingTurns = busState.tail.seqNum;

if (existingTurns > 0) {
	console.log(`\nResuming conversation (${existingTurns} messages on bus).`);

	// Catch up each guest on any bus messages they missed.
	for (const state of guestStates) {
		const missed = await readBusAfter(state.lastBusSeqNum);
		const fromOthers = missed.filter(
			(m) => m.msg.from !== state.guest.name && m.msg.from !== "host",
		);
		for (const { msg, seqNum } of fromOthers) {
			await saveToMemory(
				state,
				"user",
				`[${msg.from}]: ${msg.content}`,
				seqNum,
			);
		}
		if (fromOthers.length > 0) {
			console.log(
				`  ${state.guest.name}: caught up on ${fromOthers.length} missed messages`,
			);
		}
	}
} else {
	console.log("\nFresh dinner party!");
}

// ---------------------------------------------------------------------------
// Conversation loop
// ---------------------------------------------------------------------------

const topic = process.argv[2] ?? "What does it mean to live a good life?";

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});
const ask = (query: string) =>
	new Promise<string>((resolve) => rl.question(query, resolve));

// If fresh start, the host opens with the topic.
let turnNumber = existingTurns;
if (turnNumber === 0) {
	console.log(`\nHost: "${topic}"\n`);
	const busSeqNum = await postToBus({
		from: "host",
		content: topic,
		turn: turnNumber++,
	});

	// Every guest hears the host's opening.
	for (const state of guestStates) {
		await saveToMemory(state, "user", `[Host]: ${topic}`, busSeqNum);
	}
} else {
	console.log();
}

const guestNames = guestStates.map((s) => s.guest.name).join(", ");
console.log(
	`\nControls: Enter to advance, type to speak as host, "exit" to leave.`,
);
console.log(`Guests: ${guestNames}\n`);

async function cleanup() {
	rl.close();
	const closes = [
		busProducer.close().catch(() => {}),
		busStream.close().catch(() => {}),
		...guestStates.flatMap((s) => [
			s.producer.close().catch(() => {}),
			s.stream.close().catch(() => {}),
		]),
	];
	await Promise.allSettled(closes);
}

// Handle Ctrl+C gracefully.
process.on("SIGINT", async () => {
	console.log("\n\nDinner party paused. Run again to resume the conversation.");
	await cleanup();
	process.exit(0);
});

let guestIndex = turnNumber > 0 ? (turnNumber - 1) % guestStates.length : 0;

while (true) {
	const nextGuest = guestStates[guestIndex].guest.name;
	const input = await ask(`(${nextGuest} is next) > `);

	if (input.trim().toLowerCase() === "exit") break;

	// If the user typed something, post it as the host.
	if (input.trim()) {
		console.log();
		const busSeqNum = await postToBus({
			from: "host",
			content: input.trim(),
			turn: turnNumber++,
		});
		for (const state of guestStates) {
			await saveToMemory(state, "user", `[Host]: ${input.trim()}`, busSeqNum);
		}
	}

	const state = guestStates[guestIndex];

	// Generate this guest's response.
	const result = await generateText({
		model: openai("gpt-4o-mini"),
		messages: state.messages,
	});

	const response = result.text;
	console.log(`  ${state.guest.name}: ${response}\n`);

	// Post to the shared bus.
	const busSeqNum = await postToBus({
		from: state.guest.name,
		content: response,
		turn: turnNumber++,
	});

	// Save to the speaker's own memory as an assistant turn.
	await saveToMemory(state, "assistant", response, busSeqNum);

	// All other guests hear this message as a user turn.
	for (const other of guestStates) {
		if (other === state) continue;
		await saveToMemory(
			other,
			"user",
			`[${state.guest.name}]: ${response}`,
			busSeqNum,
		);
	}

	// Round-robin to the next guest.
	guestIndex = (guestIndex + 1) % guestStates.length;
}

console.log("\nDinner party paused. Run again to resume the conversation.");
await cleanup();
