import {
	AppendInput,
	AppendRecord,
	S2,
	S2Environment,
	S2Error,
} from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to run the read session example.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN so we know which basin to use.");
}

const streamName = process.env.S2_STREAM ?? "docs/read-session";

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

// Ensure there is at least one record so the snippet has something to show.
await stream.append(
	AppendInput.create([
		AppendRecord.string({ body: `hello @ ${new Date().toISOString()}` }),
	]),
);

// snippet-region read-session-core start
const readSession = await stream.readSession({
	start: { from: { tailOffset: 10 }, clamp: true },
	stop: { wait: 10 },
});

for await (const record of readSession) {
	console.log(record.seqNum, record.body);
}
// snippet-region read-session-core end

await stream.close();
