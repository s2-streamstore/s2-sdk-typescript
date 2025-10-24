import { AppendRecord, S2 } from "../src";

const s2 = new S2({
	accessToken: process.env.S2_ACCESS_TOKEN!,
});

const basins = await s2.basins.list();
if (!basins.basins[0]) {
	throw new Error("No basin found");
}
const basin = s2.basin(basins.basins[0].name);
const streams = await basin.streams.list();
if (streams.streams[0]) {
	const stream = basin.stream(streams.streams[0].name);
	// Create an append session
	const session = await stream.appendSession();

	// Create a batcher with options
	const batcher = session.makeBatcher({
		lingerDuration: 20, // 20ms
		maxBatchSize: 10,
	});

	// Submit individual records to the batcher
	// These will be batched and sent automatically
	// Now returns promises that resolve when acks are received
	const promise1 = batcher.submit(AppendRecord.make("record 1"));
	const promise2 = batcher.submit(AppendRecord.make("record 2"));
	const promise3 = batcher.submit([
		AppendRecord.make("record 3"),
		AppendRecord.make("record 4"),
	]);

	// You can also submit directly to the session (bypasses batching)
	const urgentPromise = session.submit(AppendRecord.make("urgent record"));

	// The batcher will continue batching
	const promise4 = batcher.submit(AppendRecord.make("record 5"));

	// Wait for all acks to come back
	const allAcks = await Promise.all([
		promise1,
		promise2,
		promise3,
		urgentPromise,
		promise4,
	]);
	console.log("All records acknowledged:", allAcks);

	// Flush and close the batcher
	batcher.flush();
	await batcher.close();

	// Close the session (waits for all appends to complete)
	await session.close();

	// You can also use the acks stream to track acknowledgements
	const session2 = await stream.appendSession();
	const acks = session2.acks();

	// Read acks in parallel with submitting
	(async () => {
		for await (const ack of acks) {
			console.log("Received ack:", ack);
		}
	})();

	const ack = await session2.submit([{ body: "test" }]);
	console.log("Single record ack:", ack);

	await session2.close();

	// Example: Error handling with promises
	const session3 = await stream.appendSession();
	try {
		const errorPromise = session3.submit([{ body: "will fail" }]);
		// If there's an error (e.g., network issue, validation error),
		// the promise will reject
		await errorPromise;
	} catch (error) {
		console.error("Append failed:", error);
	}
	await session3.close();
}
