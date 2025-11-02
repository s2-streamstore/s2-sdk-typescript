import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppendRecord, S2 } from "../index.js";

describe("ReadSession Integration Tests", () => {
	let s2: S2;
	let basinName: string;
	let streamName: string;

	beforeAll(() => {
		const token = process.env.S2_ACCESS_TOKEN;
		const basin = process.env.S2_BASIN;
		if (!token || !basin) {
			throw new Error(
				"S2_ACCESS_TOKEN and S2_BASIN environment variables are required for e2e tests",
			);
		}
		s2 = new S2({ accessToken: token });
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
		await stream.append([AppendRecord.make("read-test-1")]);
		await stream.append([AppendRecord.make("read-test-2")]);
		await stream.append([AppendRecord.make("read-test-3")]);
	});

	afterAll(async () => {
		// Clean up: delete the test stream
		if (basinName && streamName) {
			try {
				const basin = s2.basin(basinName);
				await basin.streams.delete({ stream: streamName });
			} catch (error) {
				// Ignore cleanup errors
				console.warn("Failed to cleanup test stream:", error);
			}
		}
	});

	it("should read records from the beginning using readSession", async () => {
		const basin = s2.basin(basinName);
		const stream = basin.stream(streamName);

		// Use tail_offset to read from a known valid position
		const session = await stream.readSession({
			seq_num: 0,
			count: 3,
		});

		const records: Array<{ seq_num: number; body?: string }> = [];
		for await (const record of session) {
			records.push({ seq_num: record.seq_num, body: record.body });
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
			expect(records[i]?.seq_num).toBe((records[i - 1]?.seq_num ?? 0) + 1);
		}
	});

	it("should update streamPosition during read", async () => {
		const basin = s2.basin(basinName);
		const stream = basin.stream(streamName);

		// Use tail_offset to read from a known valid position
		const session = await stream.readSession({
			seq_num: 0,
			count: 2,
		});

		// Initially streamPosition should be undefined
		expect(session.streamPosition).toBeUndefined();

		const records: Array<{ seq_num: number }> = [];
		for await (const record of session) {
			records.push({ seq_num: record.seq_num });
			// streamPosition should be updated after reading
			if (session.streamPosition) {
				expect(session.streamPosition.seq_num).toBeGreaterThanOrEqual(
					record.seq_num,
				);
			}
			if (records.length >= 2) {
				break;
			}
		}

		// After reading, streamPosition should be set
		expect(session.streamPosition).toBeDefined();
		expect(session.streamPosition?.seq_num).toBeGreaterThan(0);
	});

	it("should read records as bytes format", async () => {
		const basin = s2.basin(basinName);
		const stream = basin.stream(streamName);

		const session = await stream.readSession({
			seq_num: 0,
			count: 1,
			as: "bytes",
		});

		const records: Array<{ seq_num: number; body?: Uint8Array }> = [];
		for await (const record of session) {
			records.push({ seq_num: record.seq_num, body: record.body });
			break;
		}

		expect(records.length).toBeGreaterThanOrEqual(1);
		if (records[0]?.body) {
			const test = new TextDecoder().decode(records[0].body);
			expect(test).toEqual("read-test-1");
		}
	});
});
