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
  
  // First, check the tail to see what's available
  const tail = await stream.checkTail();
  console.log("Stream tail:", tail);
  
  // Example 1: Read a batch of recent records (non-streaming)
  console.log("\n--- Reading last 5 records (batch) ---");
  const batch = await stream.read({
    tail_offset: 5,
    count: 5,
  });
  for (const record of batch.records ?? []) {
    console.log(`[seq ${record.seq_num}] ${record.body}`);
  }
  
  // Example 2: Stream records from the tail, waiting for new ones
  console.log("\n--- Streaming from tail (will wait 10 seconds for new records) ---");
  const readSession = await stream.readSession({
    clamp: true,
    wait: 10, // wait up to 10 seconds for new records
  });
  
  let count = 0;
  for await (const record of readSession) {
    console.log(`[seq ${record.seq_num}] ${record.body}`);
    console.log("new tail", readSession.streamPosition?.seq_num);
    count++;
    if (count >= 10) {
      console.log("Read 10 records, stopping...");
      break;
    }
  }
  console.log("Done reading");
}
