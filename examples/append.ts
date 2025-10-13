import { S2 } from "../src";

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
  console.log(`appending to s2://${basins.basins[0].name}/${streams.streams[0].name}`);
  await stream.append({
    records: [{
      body: `Hello`,
    }]
  });
  console.log("appended");
}
