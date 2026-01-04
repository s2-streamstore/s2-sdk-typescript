import {
	AppendInput,
	AppendRecord,
	FencingTokenMismatchError,
	S2,
	S2Environment,
} from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to a valid access token.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN to point at your basin.");
}

const streamName = process.env.S2_STREAM ?? "fencing/demo";

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
});

const stream = s2.basin(basinName).stream(streamName);

const fencingToken = `writer-${Date.now()}`;
console.log("Establishing new fencing token:", fencingToken);

await stream.append(AppendInput.create([AppendRecord.fence(fencingToken)]));

console.log("Appending records with the fencing token.");
await stream.append(
	AppendInput.create(
		[
			AppendRecord.string({ body: "first writer record" }),
			AppendRecord.string({ body: "second writer record" }),
		],
		{ fencingToken },
	),
);

console.log("Reusing the same fencing token succeeds.");
await stream.append(
	AppendInput.create([AppendRecord.string({ body: "still fenced" })], {
		fencingToken,
	}),
);

console.log(
	"Fencing tokens are only enforced for appenders who supply one. Not supply one should succeed.",
);
await stream.append(
	AppendInput.create([AppendRecord.string({ body: "no token needed" })]),
);

console.log("Providing an incorrect token.");
const competingToken = `${fencingToken}-competing`;
try {
	await stream.append(
		AppendInput.create([AppendRecord.string({ body: "unauthorized" })], {
			fencingToken: competingToken,
		}),
	);
	throw new Error("Competing append unexpectedly succeeded.");
} catch (error: unknown) {
	if (error instanceof FencingTokenMismatchError) {
		console.log(
			"Competing writer rejected. Expected fence:",
			error.expectedFencingToken,
		);
	} else {
		throw error;
	}
}

console.log("Rotate the fencing token using a command record.");
await stream.append(
	AppendInput.create(
		[
			AppendRecord.fence(competingToken),
			AppendRecord.string({ body: "new writer record" }),
		],
		{
			fencingToken,
		},
	),
);

console.log("New fencing token now owns the stream.");
await stream.append(
	AppendInput.create([AppendRecord.string({ body: "follow-up" })], {
		fencingToken: competingToken,
	}),
);
