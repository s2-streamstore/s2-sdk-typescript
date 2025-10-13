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
  console.log(`reading s2://${basins.basins[0].name}/${streams.streams[0].name}`);
  
  const readSession = await stream.readSession({
    tail_offset: 5,
    wait: 10, // wait up to 10 seconds for new records
    as: "bytes",
  });
  
  for await (const record of readSession) {
    console.log(`[seq ${record.seq_num}] ${record.body}`);
    console.log("new tail", readSession.streamPosition?.seq_num);
  }
  console.log("Done reading");
}
