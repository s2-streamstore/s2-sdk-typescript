import { AppendInput, AppendRecord, S2 } from "../src/index.js";

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

	// Append records using the new structured API
	const input1 = AppendInput.create([
		AppendRecord.string({ body: "record 1" }),
		AppendRecord.string({ body: "record 2" }),
	]);

	const ack1 = await stream.append(input1);
	console.log("Batch appended:", ack1);

	// Append with conditional parameters
	const input2 = AppendInput.create(
		[
			AppendRecord.string({ body: "record 3" }),
			AppendRecord.string({ body: "record 4" }),
		],
		{
			matchSeqNum: ack1.tail.seqNum,
			fencingToken: "my-fence-token",
		},
	);

	const ack2 = await stream.append(input2);
	console.log("Conditional batch appended:", ack2);
}
