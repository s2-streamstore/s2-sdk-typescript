import {
	AppendInput,
	AppendRecord,
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

console.log("Opening appendSession with maxInflightBytes=1MiB.");
const appendSession = await stream.appendSession({
	maxInflightBytes: 1024 * 1024,
});

// Demonstrate matchSeqNum by anchoring to the last ack.
const startSeq = mixedAck.end.seqNum;
const appendAck = await appendSession.submit(
	AppendInput.create(
		[
			AppendRecord.string({ body: "session record A" }),
			AppendRecord.string({ body: "session record B" }),
		],
		{ matchSeqNum: startSeq },
	),
);

console.log("Session submit acked range:");
console.dir(await appendAck.ack(), { depth: null });

console.log("Closing append session to flush outstanding batches.");
await appendSession.close();

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
