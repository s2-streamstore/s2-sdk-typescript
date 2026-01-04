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
	throw new Error("Set S2_BASIN so we know where to work.");
}

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
});

const basin = s2.basin(basinName);
const streams = basin.streams;
const streamName = process.env.S2_STREAM ?? "timestamped/demo";

await streams
	.create({
		stream: streamName,
		config: {
			timestamping: {
				mode: "client-require",
				uncapped: true,
			},
		},
	})
	.catch((error: unknown) => {
		if (error instanceof S2Error && error.status === 409) {
			console.log(`Stream ${streamName} already exists.`);
			return;
		}
		throw error;
	});

let stream = basin.stream(streamName);
try {
	await stream.append(
		AppendInput.create([AppendRecord.string({ body: "Hello, world!" })]),
	);
	throw new Error(
		"Append without timestamp unexpectedly succeeded - timestamping mode should reject it.",
	);
} catch (error: unknown) {
	if (error instanceof S2Error && error.status === 400) {
		console.log("Stream correctly rejected append without a timestamp.");
	} else {
		throw error;
	}
}

const ack = await stream.append(
	AppendInput.create([
		AppendRecord.string({
			body: "Hello, world! With a timestamp.",
			timestamp: new Date(2026, 1, 1, 12, 0, 0, 0),
		}),
		AppendRecord.string({
			body: "Hello, world! With a timestamp.",
			timestamp: new Date(2027, 1, 1, 12, 0, 0, 0),
		}),
	]),
);

const batch1 = await stream.read({
	start: { from: { timestamp: new Date(2026, 2, 1, 12) } },
});
console.log("Read starting from 2026-03-01T12:00:00.000Z:");
console.dir(batch1, { depth: null });

const batch2 = await stream.read({
	start: { from: { timestamp: new Date(2025, 2, 1, 12) } },
});
console.log("Read starting from 2025-03-01T12:00:00.000Z:");
console.dir(batch2, { depth: null });
