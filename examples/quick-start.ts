import {
	AppendInput,
	AppendRecord,
	S2,
	S2Environment,
	S2Error,
} from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to run the quick-start example.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN so we know which basin to use.");
}

const streamName = process.env.S2_STREAM ?? "docs/quick-start";

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
});

const basin = s2.basin(basinName);
await basin.streams.create({ stream: streamName }).catch((error: unknown) => {
	if (!(error instanceof S2Error && error.status === 409)) {
		throw error;
	}
});

const stream = basin.stream(streamName);

// Make a single append call; the promise resolves when the data is durable.
const ack = await stream.append(
	AppendInput.create([
		AppendRecord.string({
			body: "Hello from the docs snippet!",
			headers: [["content-type", "text/plain"]],
		}),
		AppendRecord.bytes({
			body: new TextEncoder().encode("Bytes payload"),
		}),
	]),
);

console.log(
	`Appended records ${ack.start.seqNum} through ${ack.end.seqNum}. Tail is now ${ack.tail.seqNum}.`,
);

// Read the two records back as bytes.
const batch = await stream.read(
	{
		start: { from: { seqNum: ack.start.seqNum } },
		stop: { limits: { count: 2 } },
	},
	{ as: "bytes" },
);

for (const record of batch.records) {
	console.log(`[read] ${record.seqNum}:`, record.body);
}
