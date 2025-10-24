import { AppendRecord, S2 } from "../src";

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
		count: 5,
		seq_num: 0,
	});
	console.log(
		"read",
		stringRead.records?.[0]?.body,
		stringRead.records?.[0]?.headers,
	);
	const bytesRead = await stream.read({ as: "bytes", count: 5, seq_num: 0 });
	console.log(
		"read bytes",
		bytesRead.records?.[0]?.body,
		bytesRead.records?.[0]?.headers,
	);

	const append = await stream.append([
		AppendRecord.make("Hello, world!", {
			foo: "bar",
		}),
		AppendRecord.make(new Uint8Array([1, 2, 3]), {
			foo: "bar",
		}),
		AppendRecord.make(new Uint8Array([1, 2, 3]), [
			[new TextEncoder().encode("foo"), new TextEncoder().encode("bar")],
			[new TextEncoder().encode("baz"), "bak"],
			["qux", new TextEncoder().encode("quux")],
		]),
		AppendRecord.fence("my-fence"),
		AppendRecord.trim(0),
		AppendRecord.command("foo"),
		// still can just make by hand:
		{
			body: "hello, world!",
			headers: [["foo", "bar"]],
			timestamp: new Date().getTime(),
		},
	]);
	console.log("append", append);
	const readSession = await stream.readSession({
		clamp: true,
		tail_offset: 10,
	});
	for await (const record of readSession) {
		console.log("record", record);
	}
}
