import {
	AppendRecord,
	BatchTransform,
	Producer,
	S2,
	S2Environment,
	S2Error,
} from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to a valid access token.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN before running the producer example.");
}

const streamName = process.env.S2_STREAM ?? "producer/demo";

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
	retry: {
		// Producer can safely retry all batches because it maintains matchSeqNum.
		appendRetryPolicy: "all",
	},
});

const basin = s2.basin(basinName);
try {
	await basin.streams.create({ stream: streamName });
	console.log("Created stream:", streamName);
} catch (error: unknown) {
	if (error instanceof S2Error && error.status === 409) {
		console.log("Stream already exists:", streamName);
	} else {
		throw error;
	}
}

const stream = basin.stream(streamName);
const tail = await stream.checkTail();

// snippet-region producer-core start
const producer = new Producer(
	new BatchTransform({
		// Linger and collect new records for up to 25ms per batch.
		lingerDurationMillis: 25,
		maxBatchRecords: 200,
	}),
	await stream.appendSession(),
);

const tickets = [];
for (let i = 0; i < 10; i += 1) {
	const ticket = await producer.submit(
		AppendRecord.string({
			body: `record-${i}`,
		}),
	);
	tickets.push(ticket);
}

const acks = await Promise.all(tickets.map((ticket) => ticket.ack()));
for (const ack of acks) {
	console.log("Record durable at seqNum:", ack.seqNum());
}

// Use the seqNum of the third ack as a coordinate for reading it back.
let record3 = await stream.read({
	start: { from: { seqNum: acks[3].seqNum() } },
	stop: { limits: { count: 1 } },
});
console.dir(record3, { depth: null });

await producer.close();
await stream.close();
// snippet-region producer-core end
