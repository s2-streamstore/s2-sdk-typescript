import { AppendRecord, BatchTransform, S2 } from "../src/index.js";

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

	// You can submit directly to the session and get acknowledgement promises
	const ack1 = await session.submit([AppendRecord.make("record 1")]);
	const ack2 = await session.submit([AppendRecord.make("record 2")]);
	console.log("Direct submits acknowledged:", ack1, ack2);

	// Close the session (waits for all appends to complete)
	await session.close();

	// Example: Using BatchTransform with streaming pipeline
	const session2 = await stream.appendSession();

	// Create a batcher that will batch records
	const batcher = new BatchTransform({
		lingerDuration: 20,
		maxBatchRecords: 10,
	});

	// Pipe batches directly to the session
	const pipePromise = batcher.readable.pipeTo(session2);

	// Collect acks in the background
	const acksPromise = (async () => {
		const collectedAcks = [];
		for await (const ack of session2.acks()) {
			console.log("Received ack:", ack);
			collectedAcks.push(ack);
		}
		return collectedAcks;
	})();

	// Write records to the batcher
	const writer = batcher.writable.getWriter();
	await writer.write(AppendRecord.make("batched record 1"));
	await writer.write(AppendRecord.make("batched record 2"));
	await writer.write(AppendRecord.make("batched record 3"));
	await writer.close();

	// Wait for pipeline to complete
	await pipePromise;

	// Get all the acks
	const allAcks = await acksPromise;
	console.log("All batched records acknowledged:", allAcks);
}
