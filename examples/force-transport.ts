import {
	AppendInput,
	AppendRecord,
	S2,
	S2Environment,
	S2Error,
} from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to select a transport.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN so we know which basin to inspect.");
}

const streamName = process.env.S2_STREAM ?? "docs/force-transport";

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

// snippet-region force-transport start
// Override the automatic transport detection to force the fetch transport.
const stream = basin.stream(streamName, {
	forceTransport: "fetch",
});
// snippet-region force-transport end

const appendSession = await stream.appendSession({
	maxInflightBytes: 1024 * 1024 * 2,
});

let submitTickets = [];
for (let i = 0; i < 1000; i++) {
	console.log("Submitting record %d", i);
	const ticket = await appendSession.submit(
		AppendInput.create([AppendRecord.string({ body: `${i}` })]),
	);
	submitTickets.push(ticket.ack());
}
console.log("Awaiting durability.");
let durable = await Promise.all(submitTickets);
for (const ack of durable) {
	console.dir(ack, { depth: null });
}

await appendSession.close();
await stream.close();
