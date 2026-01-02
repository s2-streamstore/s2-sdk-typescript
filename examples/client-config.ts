import { S2, S2Environment, S2Error } from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to configure the SDK.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN so we know which basin to inspect.");
}

const streamName = process.env.S2_STREAM ?? "docs/client-config";

// Global retry config applies to every stream/append/read session created via this client.
const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
	retry: {
		maxAttempts: 3,
		minDelayMillis: 100,
		maxDelayMillis: 500,
		appendRetryPolicy: "all",
		requestTimeoutMillis: 5_000,
	},
});

const basin = s2.basin(basinName);
await basin.streams.create({ stream: streamName }).catch((error: unknown) => {
	if (!(error instanceof S2Error && error.status === 409)) {
		throw error;
	}
});

const stream = basin.stream(streamName);
const tail = await stream.checkTail();
console.log("Tail info:");
console.dir(tail, { depth: null });
