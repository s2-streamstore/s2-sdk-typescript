import {
	type BasinConfig,
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
	throw new Error("Set S2_BASIN to the basin you'd like to manage.");
}

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
});

console.log(`Creating basin ${basinName}...`);

const config: BasinConfig = {
	createStreamOnAppend: true,
	defaultStreamConfig: {
		storageClass: "express",
		// Retain only the last week of records.
		retentionPolicy: { ageSecs: 7 * 24 * 60 * 60 },
		// If the stream ever becomes empty for an hour, garbage collect the entire stream.
		deleteOnEmpty: { minAgeSecs: 60 * 60 },
	},
};

try {
	await s2.basins.create({
		basin: basinName,
		config,
	});
} catch (error: unknown) {
	if (error instanceof S2Error && error.status === 409) {
		console.log("Basin already exists, leaving config untouched.");
	} else {
		throw error;
	}
}

console.log("Basin created with config:");
console.dir(config, { depth: null });

const fetched = await s2.basins.getConfig({ basin: basinName });
console.log("Service-reported config (use this to confirm future edits):");
console.dir(fetched, { depth: null });
