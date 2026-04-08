/**
 * Documentation examples for Metrics page.
 * These snippets are extracted by the docs build script.
 *
 * Run with: npx tsx examples/docs/metrics.ts
 * Requires: S2_ACCESS_TOKEN environment variable
 */

import { S2, S2Environment } from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("S2_ACCESS_TOKEN is required");
}

const client = new S2({
	...S2Environment.parse(),
	accessToken,
});

// ANCHOR: metrics
const now = new Date();
const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
const sixHoursAgo = new Date(Date.now() - 6 * 3600 * 1000);
const hourAgo = new Date(Date.now() - 3600 * 1000);

// Account-level: active basins over the last 30 days
const accountMetrics = await client.metrics.account({
	set: "active-basins",
	start: thirtyDaysAgo,
	end: now,
});

// Basin-level: storage usage with hourly resolution
const basinMetrics = await client.metrics.basin({
	basin: "events",
	set: "storage",
	start: sixHoursAgo,
	end: now,
	interval: "hour",
});

// Stream-level: storage for a specific stream
const streamMetrics = await client.metrics.stream({
	basin: "events",
	stream: "user-actions",
	set: "storage",
	start: hourAgo,
	end: now,
	interval: "minute",
});
// ANCHOR_END: metrics

console.log(accountMetrics, basinMetrics, streamMetrics);
