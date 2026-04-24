/**
 * Documentation examples for Encryption page.
 * These snippets are extracted by the docs build script.
 *
 * Run with: npx tsx examples/docs/encryption.ts
 * Requires: S2_ACCESS_TOKEN, S2_BASIN, S2_ENCRYPTION_KEY environment variables
 */

import {
	AppendInput,
	AppendRecord,
	S2,
	S2Environment,
	S2Error,
} from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("S2_ACCESS_TOKEN is required");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("S2_BASIN is required");
}

const encKey = process.env.S2_ENCRYPTION_KEY;
if (!encKey) {
	throw new Error("S2_ENCRYPTION_KEY is required");
}

const client = new S2({
	...S2Environment.parse(),
	accessToken,
});

const basin = client.basin(basinName);
const streamName = `docs-encryption-${Date.now()}`;

// ANCHOR: basin-cipher
await client.basins
	.create({
		basin: basinName,
		config: { streamCipher: "aegis-256" },
	})
	.catch((e) => {
		if (!(e instanceof S2Error && e.status === 409)) throw e;
	});

await client.basins.reconfigure({
	basin: basinName,
	streamCipher: "aes-256-gcm",
});
// ANCHOR_END: basin-cipher

// Ensure stream exists
await basin.streams.create({ stream: streamName }).catch((e) => {
	if (!(e instanceof S2Error && e.status === 409)) throw e;
});

// ANCHOR: append-read
const stream = basin.stream(streamName, { encryptionKey: encKey });

await stream.append(
	AppendInput.create([AppendRecord.string({ body: "top secret" })]),
);

const batch = await stream.read({
	start: { from: { seqNum: 0 } },
	stop: { limits: { count: 10 } },
});
// ANCHOR_END: append-read

console.log("Encryption examples ok", batch.records.length);

// Cleanup
await basin.streams.delete({ stream: streamName });
await stream.close();

console.log("Encryption examples completed");
