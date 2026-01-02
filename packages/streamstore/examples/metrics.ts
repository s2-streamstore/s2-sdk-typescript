import { S2 } from "../src/index.js";

const s2 = new S2({
	accessToken: process.env.S2_ACCESS_TOKEN!,
});

// Timestamps can be Date objects or milliseconds
const activeBasins = await s2.metrics.account({
	set: "active-basins",
	start: new Date(2025, 11, 10),
	end: new Date(2026, 0, 1),
});

for (const value of activeBasins.values) {
	console.log(value);
}

console.log(activeBasins);
