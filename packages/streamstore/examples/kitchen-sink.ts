import { AppendInput, AppendRecord, S2 } from "../src/index.js";

const s2 = new S2({
	accessToken: process.env.S2_ACCESS_TOKEN!,
});

const basins = await s2.basins.list();
console.log(
	"basins",
	basins.basins.map((basin) => basin.name),
);
if (!basins.basins[0]) {
	throw new Error("No basin found");
}
const basin = s2.basin(basins.basins[0].name);
const streams = await basin.streams.list();
const streamResults = await Promise.all(
	streams.streams.map((stream) =>
		basin.streams.getConfig({ stream: stream.name }),
	),
);
console.log("streams", streamResults);

if (streams.streams[0]) {
	console.log("reading stream", streams.streams[0].name);
	const stream = basin.stream(streams.streams[0].name);
	const stringRead = await stream.read({
		start: { from: { seq_num: 0 } },
		stop: { limits: { count: 5 } },
	});
	console.log(
		"read",
		stringRead.records?.[0]?.body,
		stringRead.records?.[0]?.headers,
	);
	const bytesRead = await stream.read(
		{
			start: { from: { seq_num: 0 } },
			stop: { limits: { count: 5 } },
		},
		{ as: "bytes" },
	);
	console.log(
		"read bytes",
		bytesRead.records?.[0]?.body,
		bytesRead.records?.[0]?.headers,
	);

	// String format appends
	const stringAppend = await stream.append(
		AppendInput.create([
			AppendRecord.string({ body: "Hello, world!", headers: [["foo", "bar"]] }),
			AppendRecord.fence("my-fence"),
			AppendRecord.string({
				body: "",
				headers: [["", "foo"]],
			}),
			AppendRecord.string({
				body: "hello, world!",
				headers: [["foo", "bar"]],
				timestamp: new Date().getTime(),
			}),
		]),
	);
	console.log("string append", stringAppend);

	// Bytes format appends
	const bytesAppend = await stream.append(
		AppendInput.create([
			AppendRecord.bytes({
				body: new Uint8Array([1, 2, 3]),
				headers: [
					[new TextEncoder().encode("foo"), new TextEncoder().encode("bar")],
				],
			}),
			AppendRecord.bytes({
				body: new TextEncoder().encode("my-fence"),
				headers: [
					[new TextEncoder().encode(""), new TextEncoder().encode("fence")],
				],
			}),
			AppendRecord.trim(0),
		]),
	);
	console.log("bytes append", bytesAppend);
	const readSession = await stream.readSession({
		start: {
			from: { tail_offset: 10 },
			clamp: true,
		},
	});
	for await (const record of readSession) {
		console.log("record", record);
	}
}
