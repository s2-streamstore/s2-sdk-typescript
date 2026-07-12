import { S2, S2Environment, S2Error } from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to tune HTTP/2 flow control.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN so we know which basin to read from.");
}

const streamName = process.env.S2_STREAM ?? "docs/h2-flow-control";

// snippet-region h2-flow-control start
// Larger flow-control windows let the server keep more read data in flight,
// which helps saturate high-throughput reads over high-latency links.
const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
	http2: {
		// Per read session (HTTP/2 stream); S2 read batches are up to 1 MiB.
		initialStreamWindowSize: 32 * 1024 * 1024,
		// Per connection, shared by up to 100 sessions multiplexed on it.
		connectionWindowSize: 64 * 1024 * 1024,
	},
});
// snippet-region h2-flow-control end

const basin = s2.basin(basinName);
await basin.streams.create({ stream: streamName }).catch((error: unknown) => {
	if (!(error instanceof S2Error && error.status === 409)) {
		throw error;
	}
});

const stream = basin.stream(streamName);
const readSession = await stream.readSession({
	start: { from: { tailOffset: 10 }, clamp: true },
	stop: { waitSecs: 10 },
});
for await (const record of readSession) {
	console.log(record.seqNum, record.body);
}
await stream.close();
