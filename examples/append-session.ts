import {
	AppendInput,
	AppendRecord,
	S2,
	S2Environment,
	S2Error,
} from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to run the append-session example.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN so we know which basin to use.");
}

const streamName = process.env.S2_STREAM ?? "docs/append-session";

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
const session = await stream.appendSession({
	maxInflightBytes: 2 * 1024 * 1024,
});

try {
	// Submit a batch; you can enqueue multiple batches before awaiting acks.
	const ticket = await session.submit(
		AppendInput.create([
			AppendRecord.string({ body: "append session example" }),
		]),
	);
	const ack = await ticket.ack();
	console.log(
		"Acked batch covering seqNums %d-%d",
		ack.start.seqNum,
		ack.end.seqNum,
	);
} finally {
	await session.close();
}
