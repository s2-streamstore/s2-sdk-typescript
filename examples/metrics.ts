import { S2, S2Environment } from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to a valid access token.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN so we know which basin to inspect.");
}

const streamName = process.env.S2_STREAM ?? "metrics/demo";

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
});

console.log("Listing basins for the account (showing first 5).");
const basins = await s2.basins.list({ limit: 5 });
console.dir(basins, { depth: null });

console.log("Fetching account-level metrics.");
const accountMetrics = await s2.metrics.account({
	set: "active-basins",
	start: new Date(Date.now() - 3600 * 24 * 30 * 1000), // 30 days ago
	end: new Date(),
});
console.dir(accountMetrics, { depth: null });

console.log("Fetching basin-level metrics for %s.", basinName);
const basinStorage = await s2.metrics.basin({
	basin: basinName,
	set: "storage",
	start: new Date(Date.now() - 3600 * 6 * 1000), // 6 hours ago
	end: new Date(),
	interval: "hour",
});
console.dir(basinStorage, { depth: null });

console.log("Fetching basin-level metrics for %s.", basinName);
const basinAppendOps = await s2.metrics.basin({
	basin: basinName,
	set: "append-ops",
	start: new Date(Date.now() - 3600 * 6 * 1000), // 6 hours ago
	end: new Date(),
	interval: "hour",
});
console.dir(basinAppendOps, { depth: null });

console.log("Fetching stream-level metrics for %s/%s.", basinName, streamName);
const streamMetrics = await s2.metrics.stream({
	basin: basinName,
	stream: streamName,
	set: "storage",
	start: new Date(Date.now() - 3600 * 1000), // 1 hour ago
	end: new Date(),
	interval: "minute",
});
console.dir(streamMetrics, { depth: null });
