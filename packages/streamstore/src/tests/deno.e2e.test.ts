// deno-lint-ignore-file
/// <reference lib="deno.ns" />

/**
 * Deno e2e smoke tests.
 *
 * These exercise the SDK under Deno's runtime to verify fetch compatibility
 * and basic operations work end-to-end.
 *
 * Usage (from repo root, after `bun run build`):
 *   S2_ACCESS_TOKEN=... S2_BASIN=... deno test --no-check --allow-env --allow-net --config deno.json packages/streamstore/src/tests/deno.e2e.test.ts
 */

import { AppendInput, AppendRecord, S2, S2Stream } from "@s2-dev/streamstore";
import { assert, assertEquals, assertExists } from "@std/assert";

const accessToken = Deno.env.get("S2_ACCESS_TOKEN");
const basinName = Deno.env.get("S2_BASIN");

function shouldSkip(): boolean {
	if (!accessToken || !basinName) {
		console.log("Skipping: S2_ACCESS_TOKEN and S2_BASIN must be set");
		return true;
	}
	return false;
}

function makeClient(): InstanceType<typeof S2> {
	return new S2({ accessToken: accessToken! });
}

function makeStreamName(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// The SDK doesn't always fully consume response bodies, so we disable
// Deno's resource/op leak detection for these e2e tests.
const sanitize = { sanitizeResources: false, sanitizeOps: false };

Deno.test({
	name: "list basins",
	ignore: shouldSkip(),
	...sanitize,
	async fn() {
		const s2 = makeClient();
		const resp = await s2.basins.list();
		assert(Array.isArray(resp.basins));
	},
});

Deno.test({
	name: "check tail on fresh stream",
	ignore: shouldSkip(),
	...sanitize,
	async fn() {
		const s2 = makeClient();
		const basin = s2.basin(basinName!);
		const streamName = makeStreamName("deno-tail");
		await basin.streams.create({ stream: streamName });
		try {
			const stream = basin.stream(streamName);
			const resp = await stream.checkTail();
			assertExists(resp);
			assertExists(resp.tail);
			assertEquals(resp.tail.seqNum, 0);
		} finally {
			await basin.streams.delete({ stream: streamName });
		}
	},
});

Deno.test({
	name: "append and read",
	ignore: shouldSkip(),
	...sanitize,
	async fn() {
		const s2 = makeClient();
		const basin = s2.basin(basinName!);

		const streamName = makeStreamName("deno-rw");
		await basin.streams.create({ stream: streamName });

		try {
			const stream = basin.stream(streamName);

			const input = AppendInput.create([
				AppendRecord.string({ body: "hello from deno" }),
				AppendRecord.string({ body: "second record" }),
			]);
			const ack = await stream.append(input);
			assertExists(ack);
			assertEquals(ack.start.seqNum, 0);
			assertEquals(ack.end.seqNum, 2);

			const batch = await stream.read({
				start: { from: { seqNum: 0 }, clamp: true },
			});
			assert(batch.records.length >= 2);
			assertEquals(batch.records[0]!.body, "hello from deno");
			assertEquals(batch.records[1]!.body, "second record");
		} finally {
			await basin.streams.delete({ stream: streamName });
		}
	},
});

Deno.test({
	name: "read session",
	ignore: shouldSkip(),
	...sanitize,
	async fn() {
		const s2 = makeClient();
		const basin = s2.basin(basinName!);

		const streamName = makeStreamName("deno-rs");
		await basin.streams.create({ stream: streamName });

		try {
			const stream = basin.stream(streamName);

			// Append some records first
			const input = AppendInput.create([
				AppendRecord.string({ body: "rs-record-0" }),
				AppendRecord.string({ body: "rs-record-1" }),
				AppendRecord.string({ body: "rs-record-2" }),
			]);
			await stream.append(input);

			// Open a read session
			const session = await stream.readSession({
				start: { from: { seqNum: 0 }, clamp: true },
				stop: { limits: { count: 3 } },
			});

			const records: string[] = [];
			for await (const record of session) {
				records.push(record.body as string);
			}

			assertEquals(records, ["rs-record-0", "rs-record-1", "rs-record-2"]);

			await stream.close();
		} finally {
			await basin.streams.delete({ stream: streamName });
		}
	},
});
