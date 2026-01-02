import {
	AppendInput,
	AppendRecord,
	S2,
	S2Environment,
} from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to a valid access token.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN before running this example.");
}

const streamName = process.env.S2_STREAM ?? "explicit-trim/demo";

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
});

const basin = s2.basin(basinName);
const stream = basin.stream(streamName);

console.log("Appending three records to establish history.");
const ack = await stream.append(
	AppendInput.create([
		AppendRecord.string({ body: "record-1" }),
		AppendRecord.string({ body: "record-2" }),
		AppendRecord.string({ body: "record-3" }),
	]),
);
console.dir(ack, { depth: null });

console.log(
	"Issuing explicit trim up to _and including_ seqNum %d.",
	ack.end.seqNum,
);
await stream.append(
	AppendInput.create([AppendRecord.trim(ack.end.seqNum + 1)]),
);

// Trims are eventually consistent (usually within a minute). We'll poll below until we observe it.
console.log("Appending a fresh record after trim.");
const postTrimAck = await stream.append(
	AppendInput.create([AppendRecord.string({ body: "post-trim" })]),
);
console.dir(postTrimAck, { depth: null });

console.log(
	"Verifying trim: reading from seqNum 0 should eventually yield nothing.",
);
let trimmed = false;
for (let attempt = 0; attempt < 20; attempt += 1) {
	const afterTrim = await stream.read({
		start: { from: { seqNum: 0 }, clamp: true },
		stop: { limits: { count: 10 } },
	});
	if (afterTrim.records.length === 1) {
		console.dir(afterTrim, { depth: null });
		trimmed = true;
		break;
	}
	console.log(
		"Trim not yet visible (attempt %d), received %d records (%d..=%d). Retrying...",
		attempt + 1,
		afterTrim.records.length,
		afterTrim.records[0]?.seqNum,
		afterTrim.records[afterTrim.records.length - 1]?.seqNum,
	);
	await new Promise((resolve) => setTimeout(resolve, 6000));
}
if (!trimmed) {
	console.log(
		"Trim has not propagated yet; the service applies trims asynchronously.",
	);
}
