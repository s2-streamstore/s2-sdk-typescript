import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type S2ClientOptions, S2Environment } from "../common.js";
import { AppendInput, AppendRecord, S2, type S2Basin } from "../index.js";
import { randomToken } from "../lib/base64.js";

const hasEnv = !!process.env.S2_ACCESS_TOKEN;
const describeIf = hasEnv ? describe : describe.skip;

const TEST_TIMEOUT_MS = 60_000; // 1 minute
const STREAM_COUNT = 5000;
const STREAM_CREATE_DELAY_MS = 1; // Small delay between stream creations
const RETENTION_AGE_SECS = 600; // 10 minutes
const DELETE_ON_EMPTY_MIN_AGE_SECS = 600; // 10 minutes

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generate a random basin name that is:
 * - Globally unique (uses randomToken)
 * - Valid (lowercase alphanumeric and hyphens, 8-48 chars, no leading/trailing hyphens)
 */
const generateBasinName = (): string => {
	const prefix = "typescript-tmp-";
	// Generate random token, strip non-alphanumeric, lowercase
	const suffix = randomToken(16)
		.replace(/[^a-zA-Z0-9]/g, "")
		.toLowerCase();
	const name = `${prefix}${suffix}`;
	// Ensure max 48 chars
	return name.slice(0, 48);
};

/**
 * Helper to generate stream names in the format test/0000, test/0001, etc.
 */
const generateStreamNames = (count: number): string[] => {
	return Array.from(
		{ length: count },
		(_, i) => `test/${String(i).padStart(4, "0")}`,
	);
};

describeIf("Basin Management Integration Tests", () => {
	let s2: S2;
	let basinName: string;
	let basin: S2Basin;

	beforeAll(() => {
		const env = S2Environment.parse();
		if (!env.accessToken) return;
		s2 = new S2(env as S2ClientOptions);
	});

	afterAll(async () => {
		// Clean up: delete the test basin
		if (basinName) {
			try {
				await s2.basins.delete({ basin: basinName });
				console.log(`Cleaned up test basin: ${basinName}`);
			} catch (error) {
				console.warn(`Failed to cleanup test basin ${basinName}:`, error);
			}
		}
	}, TEST_TIMEOUT_MS);

	it(
		"should create a basin with custom config, create streams, list them, and perform operations",
		async () => {
			// Step 1: Generate a unique basin name
			basinName = generateBasinName();
			console.log(`Creating test basin: ${basinName}`);

			// Step 2: Create the basin with specific config
			const createResponse = await s2.basins.create({
				basin: basinName,
				config: {
					defaultStreamConfig: {
						retentionPolicy: { age: RETENTION_AGE_SECS },
						deleteOnEmpty: { minAgeSecs: DELETE_ON_EMPTY_MIN_AGE_SECS },
					},
				},
			});

			expect(createResponse.name).toBe(basinName);
			expect(createResponse.state).toBe("active");
			console.log(
				`Basin created: ${createResponse.name}, state: ${createResponse.state}`,
			);

			// Step 3: Get basin config and verify it matches expectations
			const basinConfig = await s2.basins.getConfig({ basin: basinName });

			expect(basinConfig.defaultStreamConfig).toBeDefined();
			expect(basinConfig.defaultStreamConfig?.retentionPolicy).toEqual({
				age: RETENTION_AGE_SECS,
			});
			expect(basinConfig.defaultStreamConfig?.deleteOnEmpty).toEqual({
				minAgeSecs: DELETE_ON_EMPTY_MIN_AGE_SECS,
			});
			// Express is the default storage class
			expect(basinConfig.defaultStreamConfig?.storageClass).toBe("express");
			console.log("Basin config verified");

			// Step 4: Create a basin client
			basin = s2.basin(basinName);

			// Step 5: Create 5000 streams with small delay between each
			const streamNames = generateStreamNames(STREAM_COUNT);
			console.log(`Creating ${STREAM_COUNT} streams...`);

			const streamCreations: Promise<
				Awaited<ReturnType<typeof basin.streams.create>>
			>[] = [];
			for (const name of streamNames) {
				streamCreations.push(basin.streams.create({ stream: name }));
				await sleep(STREAM_CREATE_DELAY_MS);
			}
			const createdStreams = await Promise.all(streamCreations);

			expect(createdStreams).toHaveLength(STREAM_COUNT);
			console.log(`Created ${createdStreams.length} streams`);

			// Step 6: List all streams and verify count and lexicographic order
			console.log("Listing all streams...");
			const listedStreams: string[] = [];
			for await (const stream of basin.streams.listAll()) {
				listedStreams.push(stream.name);
			}

			expect(listedStreams).toHaveLength(STREAM_COUNT);

			// Verify lexicographic ordering
			const sortedNames = [...listedStreams].sort();
			expect(listedStreams).toEqual(sortedNames);

			// Verify the actual names match what we created
			expect(listedStreams).toEqual(streamNames);
			console.log(`Listed ${listedStreams.length} streams in correct order`);

			// Step 7: Check a random stream's config
			const randomIndex = Math.floor(Math.random() * STREAM_COUNT);
			const randomStreamName = streamNames[randomIndex]!;
			console.log(`Checking config for random stream: ${randomStreamName}`);

			const streamConfig = await basin.streams.getConfig({
				stream: randomStreamName,
			});

			// Stream should inherit basin's default config
			expect(streamConfig.retentionPolicy).toEqual({
				age: RETENTION_AGE_SECS,
			});
			expect(streamConfig.deleteOnEmpty).toEqual({
				minAgeSecs: DELETE_ON_EMPTY_MIN_AGE_SECS,
			});
			expect(streamConfig.storageClass).toBe("express");
			console.log("Random stream config verified");

			// Step 8: Reconfigure another random stream
			const anotherRandomIndex = (randomIndex + 1) % STREAM_COUNT;
			const anotherStreamName = streamNames[anotherRandomIndex]!;
			console.log(`Reconfiguring stream: ${anotherStreamName}`);

			const reconfiguredStream = await basin.streams.reconfigure({
				stream: anotherStreamName,
				storageClass: "standard",
			});

			expect(reconfiguredStream.storageClass).toBe("standard");
			// Other config should remain unchanged
			expect(reconfiguredStream.retentionPolicy).toEqual({
				age: RETENTION_AGE_SECS,
			});

			// Read back to confirm
			const updatedConfig = await basin.streams.getConfig({
				stream: anotherStreamName,
			});
			expect(updatedConfig.storageClass).toBe("standard");
			console.log("Stream reconfiguration verified");

			// Step 9: Sanity append to the reconfigured stream
			console.log(`Appending to stream: ${anotherStreamName}`);
			const stream = basin.stream(anotherStreamName);
			const session = await stream.appendSession();

			const ticket = await session.submit(
				AppendInput.create([
					AppendRecord.string({ body: "test-record-1" }),
					AppendRecord.string({ body: "test-record-2" }),
					AppendRecord.string({ body: "test-record-3" }),
				]),
			);
			const ack = await ticket.ack();

			expect(ack.start.seqNum).toBe(0);
			expect(ack.end.seqNum).toBe(3);
			expect(ack.end.timestamp).toBeInstanceOf(Date);
			expect(ack.end.timestamp.getTime()).toBeGreaterThan(0);

			await session.close();
			console.log(
				`Append successful: seq_num ${ack.start.seqNum}-${ack.end.seqNum}`,
			);

			// Step 10: Read back and verify
			const readResult = await stream.read(
				{
					start: { from: { seqNum: 0 } },
					stop: { limits: { count: 3 } },
				},
				{ as: "string" },
			);

			expect(readResult.records).toHaveLength(3);
			expect(readResult.records[0]?.body).toBe("test-record-1");
			expect(readResult.records[1]?.body).toBe("test-record-2");
			expect(readResult.records[2]?.body).toBe("test-record-3");
			console.log("Read verification successful");

			// Step 11: Create a read-only access token with auto-prefix
			console.log("Creating read-only access token with auto-prefix...");
			const tokenId = `e2e-test-token-${randomToken(8)
				.replace(/[^a-zA-Z0-9]/g, "")
				.toLowerCase()}`;

			// Token expires 1 hour from now
			const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

			const tokenResponse = await s2.accessTokens.issue({
				id: tokenId,
				autoPrefixStreams: true,
				expiresAt: expiresAt,
				scope: {
					// Basin scope: only basins starting with "typescript"
					basins: { prefix: "typescript" },
					// Stream scope: only streams starting with "test/"
					// This is also the prefix that will be stripped with autoPrefixStreams
					streams: { prefix: "test/" },
					// Read-only via opGroups
					opGroups: {
						account: { read: true },
						basin: { read: true },
						stream: { read: true },
					},
				},
			});

			expect(tokenResponse.accessToken).toBeDefined();
			expect(tokenResponse.accessToken.length).toBeGreaterThan(0);
			console.log(`Created access token: ${tokenId}`);

			// Step 12: Create a new S2 client with the scoped token
			const scopedS2 = new S2({
				accessToken: tokenResponse.accessToken,
			});

			// Step 13: List streams using the scoped client
			// With auto_prefix_streams, the "test/" prefix should be stripped
			console.log(
				"Listing streams with scoped token (should see auto-prefixed names)...",
			);
			const scopedBasin = scopedS2.basin(basinName);
			const scopedStreamNames: string[] = [];

			for await (const streamInfo of scopedBasin.streams.listAll()) {
				scopedStreamNames.push(streamInfo.name);
			}

			// Should see all 5000 streams, but with "test/" prefix stripped
			expect(scopedStreamNames).toHaveLength(STREAM_COUNT);

			// Verify the names are stripped of "test/" prefix
			// e.g., "test/0000" becomes "0000"
			expect(scopedStreamNames[0]).toBe("0000");
			expect(scopedStreamNames[1]).toBe("0001");
			expect(scopedStreamNames[STREAM_COUNT - 1]).toBe(
				String(STREAM_COUNT - 1).padStart(4, "0"),
			);

			// Verify lexicographic ordering still holds
			const sortedScopedNames = [...scopedStreamNames].sort();
			expect(scopedStreamNames).toEqual(sortedScopedNames);
			console.log(
				`Scoped client listed ${scopedStreamNames.length} streams with auto-prefixed names`,
			);

			// Step 14: Verify read-only access - reading should work
			const scopedStream = scopedBasin.stream(
				String(anotherRandomIndex).padStart(4, "0"),
			);
			const scopedReadResult = await scopedStream.read(
				{
					start: { from: { seqNum: 0 } },
					stop: { limits: { count: 3 } },
				},
				{ as: "string" },
			);

			expect(scopedReadResult.records).toHaveLength(3);
			expect(scopedReadResult.records[0]?.body).toBe("test-record-1");
			console.log("Scoped client read verification successful");

			// Step 15: Verify read-only access - writing should fail
			let writeError: Error | undefined;
			try {
				await scopedStream.append(
					AppendInput.create([AppendRecord.string({ body: "should-fail" })]),
				);
			} catch (err) {
				writeError = err as Error;
			}
			expect(writeError).toBeDefined();
			console.log("Scoped client correctly rejected write attempt");

			console.log("All basin management tests passed!");
		},
		TEST_TIMEOUT_MS,
	);
});
