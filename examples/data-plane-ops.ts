import {
	AppendInput,
	AppendRecord,
	BatchSubmitTicket,
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
	throw new Error("Set S2_BASIN before running data-plane ops.");
}

const streamName = process.env.S2_STREAM ?? "data-plane/demo";

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
	retry: {
		// Let unary appends retry conservative by default.
		appendRetryPolicy: "noSideEffects",
	},
});

const basin = s2.basin(basinName);
const stream = basin.stream(streamName);

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

console.log("Checking tail on %s/%s", basinName, streamName);
const tail = await stream.checkTail();
console.dir(tail, { depth: null });

// snippet-region data-plane-unary start
// Append a mixed batch: string + bytes with headers.
console.log("Appending two records (string + bytes).");
const mixedAck = await stream.append(
	AppendInput.create([
		AppendRecord.string({
			body: "string payload",
			headers: [
				["record-type", "example"],
				["user-id", "123"],
			],
		}),
		AppendRecord.bytes({
			body: new TextEncoder().encode("bytes payload"),
			headers: [[new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]],
		}),
	]),
);
console.dir(mixedAck, { depth: null });
// snippet-region data-plane-unary end

console.log("Reading back the batch as strings:");
const stringBatch = await stream.read({
	start: { from: { seqNum: mixedAck.start.seqNum } },
	stop: { limits: { count: 2 } },
});
console.dir(stringBatch, { depth: null });

console.log("Reading back the batch as bytes:");
const byteBatch = await stream.read(
	{
		start: { from: { seqNum: mixedAck.start.seqNum } },
		stop: { limits: { count: 2 } },
	},
	{ as: "bytes" },
);
const byteSummaries = byteBatch.records.map(
	(record: (typeof byteBatch.records)[number]) => ({
		seqNum: record.seqNum,
		bodyLength: record.body.length,
	}),
);
console.dir(byteSummaries);

// snippet-region data-plane-append-session start
console.log("Opening appendSession with maxInflightBytes=1MiB.");
const appendSession = await stream.appendSession({
	// This determines the maximum amount of unacknowledged, pending appends,
	// which can be outstanding at any given time. This is used to apply backpressure.
	maxInflightBytes: 1024 * 1024,
});

const startSeq = mixedAck.end.seqNum;
// Submit an append batch.
// This returns a promise that resolves into a `BatchSubmitTicket` once the session has
// capacity to send it.
const append1: BatchSubmitTicket = await appendSession.submit(
	AppendInput.create([
		AppendRecord.string({ body: "session record A" }),
		AppendRecord.string({ body: "session record B" }),
	]),
);
const append2: BatchSubmitTicket = await appendSession.submit(
	AppendInput.create([AppendRecord.string({ body: "session record C" })]),
);

// The tickets can be used to wait for the append to become durable (acknowledged by S2).
console.dir(await append1.ack(), { depth: null });
console.dir(await append2.ack(), { depth: null });

console.log("Closing append session to flush outstanding batches.");
await appendSession.close();
// snippet-region data-plane-append-session end

console.log("Starting read session to tail from seqNum %d", startSeq);
const readSession = await stream.readSession({
	start: { from: { seqNum: startSeq }, clamp: true },
	stop: { limits: { count: 4 } },
});

const reader = readSession;
for await (const record of reader) {
	console.log("readSession record:", record);
}

await stream.close();
