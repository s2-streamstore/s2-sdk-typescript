import { S2, S2Environment, S2Error } from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to talk to S2.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN so we know which basin to inspect.");
}

const streamName = process.env.S2_STREAM ?? "docs/getting-started";

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
});

// List all of the basins the token can see.
const basins = await s2.basins.list();
console.log(
	"My basins:",
	basins.basins.map((basin) => basin.name),
);

const basin = s2.basin(basinName);

// Create a stream for the walkthrough if it does not already exist.
await basin.streams.create({ stream: streamName }).catch((error) => {
	if (!(error instanceof S2Error && error.status === 409)) {
		throw error;
	}
});

const stream = basin.stream(streamName);
const tail = await stream.checkTail();
console.log("Tail for %s/%s:", basinName, streamName);
console.dir(tail, { depth: null });
