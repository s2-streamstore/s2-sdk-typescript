import { beforeAll, describe, expect, it } from "vitest";
import { type S2ClientOptions, S2Environment } from "../common.js";
import { AppendInput, AppendRecord, S2 } from "../index.js";
import type { SessionTransports } from "../lib/stream/types.js";

const transports: SessionTransports[] = ["fetch", "s2s"];
const hasEnv = !!process.env.S2_ACCESS_TOKEN && !!process.env.S2_BASIN;
const describeIf = hasEnv ? describe : describe.skip;

describeIf("ReadSession Integration Tests", () => {
	let s2: S2;
	let basinName: string;
	let streamName: string;

	beforeAll(() => {
		const basin = process.env.S2_BASIN;
		if (!basin) return;
		const env = S2Environment.parse();
		if (!env.accessToken) return;
		s2 = new S2(env as S2ClientOptions);
		basinName = basin;
	});

	beforeAll(async () => {
		streamName = `integration-test-read-${crypto.randomUUID()}`;

		const basin = s2.basin(basinName);
		// Create a test stream
		await basin.streams.create({
			stream: streamName,
		});

		// Pre-populate the stream with some records for testing
		const stream = basin.stream(streamName);
		await stream.append(
			AppendInput.create([AppendRecord.string({ body: "read-test-1" })]),
		);
		await stream.append(
			AppendInput.create([AppendRecord.string({ body: "read-test-2" })]),
		);
		await stream.append(
			AppendInput.create([AppendRecord.string({ body: "read-test-3" })]),
		);
	});

	it.each(transports)(
		"should read records from the beginning using readSession (%s)",
		async (transport) => {
			const basin = s2.basin(basinName);
			const stream = basin.stream(streamName, { forceTransport: transport });

			// Use tail_offset to read from a known valid position
			const session = await stream.readSession({
				start: { from: { seq_num: 0 } },
				stop: { limits: { count: 3 } },
			});

			const records: Array<{ seqNum: number; body?: string }> = [];
			for await (const record of session) {
				records.push({ seqNum: record.seq_num, body: record.body });
				// Stop after reading 3 records
				if (records.length >= 3) {
					break;
				}
			}

			expect(records.length).toBeGreaterThanOrEqual(3);
			expect(records[0]?.body).toBe("read-test-1");
			expect(records[1]?.body).toBe("read-test-2");
			expect(records[2]?.body).toBe("read-test-3");

			// Verify sequence numbers are sequential
			for (let i = 1; i < records.length; i++) {
				expect(records[i]?.seqNum).toBe((records[i - 1]?.seqNum ?? 0) + 1);
			}
		},
	);

	it.each(transports)(
		"should update streamPosition during read (%s)",
		async (transport) => {
			const basin = s2.basin(basinName);
			const stream = basin.stream(streamName, { forceTransport: transport });

			// Use tail_offset to read from a known valid position
			const session = await stream.readSession({
				start: { from: { seq_num: 0 } },
				stop: { limits: { count: 2 } },
			});

			// Initially streamPosition should be undefined
			expect(session.nextReadPosition()).toBeUndefined();

			const records: Array<{ seqNum: number }> = [];
			for await (const record of session) {
				records.push({ seqNum: record.seq_num });
				// streamPosition should be updated after reading
				if (session.nextReadPosition()) {
					expect(session.nextReadPosition()?.seq_num).toBeGreaterThanOrEqual(
						record.seq_num,
					);
				}
				if (records.length >= 2) {
					break;
				}
			}

			// After reading, streamPosition should be set
			expect(session.nextReadPosition()).toBeDefined();
			expect(session.nextReadPosition()?.seq_num).toBeGreaterThan(0);
		},
	);

	it.each(transports)(
		"should read records as bytes format (%s)",
		async (transport) => {
			const basin = s2.basin(basinName);
			const stream = basin.stream(streamName, { forceTransport: transport });

			const session = await stream.readSession(
				{
					start: { from: { seq_num: 0 } },
					stop: { limits: { count: 1 } },
				},
				{ as: "bytes" },
			);

			const records: Array<{ seqNum: number; body?: Uint8Array }> = [];
			for await (const record of session) {
				records.push({ seqNum: record.seq_num, body: record.body });
				break;
			}

			expect(records.length).toBeGreaterThanOrEqual(1);
			if (records[0]?.body) {
				const test = new TextDecoder().decode(records[0].body);
				expect(test).toEqual("read-test-1");
			}
		},
	);
});
