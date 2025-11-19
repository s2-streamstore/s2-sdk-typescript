import { AppendRecord, BatchTransform, S2 } from "../../src/index.js";

const s2 = new S2({
	accessToken: process.env.S2_ACCESS_TOKEN!,
});

const basin = s2.basin("demo-10202025").stream("frame-stream-0007");

const sesh = await basin.readSession({ seq_num: 0 });
