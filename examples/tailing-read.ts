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
	throw new Error("Set S2_BASIN so we know which basin to use.");
}

const streamName = process.env.S2_STREAM ?? "tailing/demo";

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
});

const basin = s2.basin(basinName);
// Ensure the stream exists before starting the tail.
await basin.streams.create({ stream: streamName }).catch((error: unknown) => {
	if (!(error instanceof S2Error && error.status === 409)) {
		throw error;
	}
});

// Force the HTTP/2 transport so a single client can keep up with live traffic.
const streamClient = basin.stream(streamName, { forceTransport: "s2s" });

const appendSession = await streamClient.appendSession({
	maxInflightBytes: 2 * 1024 * 1024,
});

// AbortController lets the append loop signal when we're done tailing.
const readAbort = new AbortController();
const readSession = await streamClient.readSession(
	{
		start: { from: { seqNum: 0 }, clamp: true },
	},
	{ signal: readAbort.signal },
);

const appendLoop = async () => {
	for (let i = 0; i < 5; i += 1) {
		const ticket = await appendSession.submit(
			AppendInput.create([
				AppendRecord.string({
					body: `periodic-${i}`,
					timestamp: new Date(),
				}),
			]),
		);
		const ack = await ticket.ack();
		console.log("append ack (..%d):", ack.end.seqNum);
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	await appendSession.close();
};

// Keep tailing until we decide to abort the stream.
const readLoop = async () => {
	try {
		for await (const record of readSession) {
			console.log("tailing read:", record.seqNum, record.body);
			console.log("last observed tail: %s, next read position %s", readSession.lastObservedTail(), readSession.nextReadPosition())
		}
	} catch (error: unknown) {
		if (
			error instanceof S2Error &&
			(error.code === "ABORTED" || error.status === 499)
		) {
			console.log("Read aborted:", error.message);
			return;
		}
		if (error instanceof DOMException && error.name === "AbortError") {
			console.log("DOMException", error.message);
			return;
		}
		throw error;
	}
};

const readPromise = readLoop();
const appendPromise = appendLoop();
await appendPromise;
console.log("Finished appending. Allowing read session to drain.");
readAbort.abort("done");
await readPromise;
await streamClient.close();
