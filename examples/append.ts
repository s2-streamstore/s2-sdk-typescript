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
  stream.append(AppendRecord.fence(""),)
	// Create an append session
	const session = await stream.appendSession();

	// Create a batcher with options
	const batcher = session.makeBatcher({
		lingerDuration: 20, // 20ms
		maxBatchSize: 10,
	});

	// Submit individual records to the batcher
	// These will be batched and sent automatically
	batcher.submit(AppendRecord.make("record 1"));
	batcher.submit(AppendRecord.make("record 2"));
	batcher.submit([
		AppendRecord.make("record 3"),
		AppendRecord.make("record 4"),
	]);

	// You can also submit directly to the session (bypasses batching)
	session.submit([AppendRecord.make("urgent record")], {
		fencing_token: "different-fence",
	});

	// The batcher will continue batching
	batcher.submit(AppendRecord.make("record 5"));

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

	session2.submit([{ body: "test" }]);

	await session2.close();

}