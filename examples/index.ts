import { S2 } from "../src";

const s2 = new S2({
  accessToken: "123",
});

const basins = await s2.basins.list();
const accessTokens = await s2.accessTokens.list();
const basin = s2.basin("test");
const streams = await basin.streams.list();
