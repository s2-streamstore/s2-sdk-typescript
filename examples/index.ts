import { S2 } from "../src";

const s2 = new S2({
  accessToken: process.env.S2_ACCESS_TOKEN!,
});

const basins = await s2.basins.list();
console.log(
  "basins",
  basins.basins.map((basin) => basin.name)
);
if (!basins.basins[0]) {
  throw new Error("No basin found");
}
const basin = s2.basin(basins.basins[0].name);
const streams = await basin.streams.list();
const streamResults = await Promise.all(
  streams.streams.map((stream) =>
    basin.streams.getConfig({ stream: stream.name })
  )
);
console.log("streams", streamResults);

if (streams.streams[0]) {
  const stream = basin.stream(streams.streams[0].name);
  const stringRead = await stream.read();
  console.log("read", stringRead.records?.[0]?.body, stringRead.records?.[0]?.headers);
  const bytesRead = await stream.read({ as: "bytes" });
  console.log("read bytes", bytesRead.records?.[0]?.body, bytesRead.records?.[0]?.headers);

  const append = await stream.append({
    records: [{
      body: "Hello, world!",
    }, {
      body: new Uint8Array([1, 2, 3]),
    }],
  });
  console.log("append", append);
}
