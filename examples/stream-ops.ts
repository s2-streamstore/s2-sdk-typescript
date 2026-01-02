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

const userStreams = [
	"user/0001",
	"user/0002",
	"user/0003",
	"user/0004",
] as const;

console.log("Creating streams:");
const createdStreams = await Promise.all(
	userStreams.map((name) =>
		streams
			.create({
				stream: name,
			})
			.catch((error: unknown) => {
				if (error instanceof S2Error && error.status === 409) {
					console.log(`Stream ${name} already exists.`);
					return undefined;
				}
				throw error;
			}),
	),
);

for (const stream of createdStreams) {
	if (stream) {
		console.log(`Created stream:`);
		console.dir(stream, { depth: null });
	}
}

console.log("Reconfiguring stream: %s", userStreams[0]);

// Tighten retention policy on the first stream.
let reconfigured = await streams.reconfigure({
	stream: userStreams[0],
	retentionPolicy: { ageSecs: 24 * 60 * 60 },
});
console.log("Reconfigured:");
console.dir(reconfigured, { depth: null });

// Delete the second stream.
console.log("Deleting stream: %s", userStreams[1]);
await streams.delete({ stream: userStreams[1] });

// Create a new stream simply by appending.
// This requires the basin to have been configured with createStreamOnAppend: true.
const streamName = "user/0005";
const stream = basin.stream(streamName);
const appendResult = await stream.append(
	AppendInput.create([
		AppendRecord.string({ body: "Hello, world!" }),
		AppendRecord.string({ body: "Goodbye, world!", headers: [["foo", "bar"]] }),
	]),
);

// List all streams in the basin.
console.log("Listing all streams.");
for await (const stream of streams.listAll()) {
	console.dir(stream, { depth: null });
}
