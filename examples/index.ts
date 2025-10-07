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
