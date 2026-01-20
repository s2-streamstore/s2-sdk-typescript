/**
 * Documentation examples for Streams page.
 * These snippets are extracted by the docs build script.
 *
 * Run with: npx tsx examples/docs/streams.ts
 * Requires: S2_ACCESS_TOKEN, S2_BASIN environment variables
 */

import {
	AppendInput,
	AppendRecord,
	BatchTransform,
	Producer,
	S2,
	S2Environment,
	S2Error,
} from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("S2_ACCESS_TOKEN is required");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("S2_BASIN is required");
}

const client = new S2({
	...S2Environment.parse(),
	accessToken,
});

const basin = client.basin(basinName);
const streamName = `docs-streams-${Date.now()}`;

// Ensure stream exists
await basin.streams.create({ stream: streamName }).catch((e) => {
	if (!(e instanceof S2Error && e.status === 409)) throw e;
});


// ANCHOR: simple-append
const stream = basin.stream(streamName);
const ack = await stream.append(
	AppendInput.create([
		AppendRecord.string({ body: "first event" }),
		AppendRecord.string({ body: "second event" }),
	]),
);

// ack tells us where the records landed
console.log(`Wrote records ${ack.start.seqNum} through ${ack.end.seqNum - 1}`);
// ANCHOR_END: simple-append

// ANCHOR: simple-read
const batch = await stream.read({
	start: { from: { seqNum: 0 } },
	stop: { limits: { count: 100 } },
});

for (const record of batch.records) {
	console.log(`[${record.seqNum}] ${record.body}`);
}
// ANCHOR_END: simple-read

async function appendSessionExample() {
	// ANCHOR: append-session
	const session = await stream.appendSession();

	// Submit a batch - this enqueues it and returns a ticket
	const ticket = await session.submit(
		AppendInput.create([
			AppendRecord.string({ body: "event-1" }),
			AppendRecord.string({ body: "event-2" }),
		]),
	);

	// The ticket resolves when the batch is durable
	const ack = await ticket.ack();
	console.log(`Durable at seqNum ${ack.start.seqNum}`);

	await session.close();
	// ANCHOR_END: append-session
}

async function producerExample() {
	// ANCHOR: producer
	const producer = new Producer(
		new BatchTransform({ lingerDurationMillis: 5 }),
		await stream.appendSession(),
	);

	// Submit individual records
	const ticket = await producer.submit(
		AppendRecord.string({ body: "my event" }),
	);

	// Get the exact sequence number for this record
	const ack = await ticket.ack();
	console.log(`Record durable at seqNum ${ack.seqNum()}`);

	await producer.close();
	// ANCHOR_END: producer
}

async function readSessionExample() {
	// ANCHOR: read-session
	const session = await stream.readSession({
		start: { from: { seqNum: 0 } },
	});

	for await (const record of session) {
		console.log(`[${record.seqNum}] ${record.body}`);
	}
	// ANCHOR_END: read-session
}

async function readSessionTailOffset() {
	// ANCHOR: read-session-tail-offset
	// Start reading from 10 records before the current tail
	const session = await stream.readSession({
		start: { from: { tailOffset: 10 } },
	});

	for await (const record of session) {
		console.log(`[${record.seqNum}] ${record.body}`);
	}
	// ANCHOR_END: read-session-tail-offset
}

async function readSessionTimestamp() {
	// ANCHOR: read-session-timestamp
	// Start reading from a specific timestamp
	const oneHourAgo = new Date(Date.now() - 3600 * 1000);
	const session = await stream.readSession({
		start: { from: { timestamp: oneHourAgo } },
	});

	for await (const record of session) {
		console.log(`[${record.seqNum}] ${record.body}`);
	}
	// ANCHOR_END: read-session-timestamp
}

async function readSessionUntil() {
	// ANCHOR: read-session-until
	// Read records until a specific timestamp
	const oneHourAgo = new Date(Date.now() - 3600 * 1000);
	const session = await stream.readSession({
		start: { from: { seqNum: 0 } },
		stop: { untilTimestamp: oneHourAgo },
	});

	for await (const record of session) {
		console.log(`[${record.seqNum}] ${record.body}`);
	}
	// ANCHOR_END: read-session-until
}

async function readSessionWait() {
	// ANCHOR: read-session-wait
	// Read all available records, and once reaching the current tail, wait an additional 30 seconds for new ones
	const session = await stream.readSession({
		start: { from: { seqNum: 0 } },
		stop: { waitSecs: 30 },
	});

	for await (const record of session) {
		console.log(`[${record.seqNum}] ${record.body}`);
	}
	// ANCHOR_END: read-session-wait
}

async function checkTailExample() {
	// ANCHOR: check-tail
	const { tail } = await stream.checkTail();
	console.log(`Stream has ${tail.seqNum} records`);
	// ANCHOR_END: check-tail
}

// Run examples
await appendSessionExample();
await producerExample();
await checkTailExample();

// Cleanup
await basin.streams.delete({ stream: streamName });
await stream.close();

console.log("Streams examples completed");
