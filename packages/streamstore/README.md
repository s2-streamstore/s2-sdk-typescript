# @s2-dev/streamstore

TypeScript SDK for [S2](https://s2.dev), a serverless data store for streams.

This package is the core client for S2's [REST API](https://s2.dev/docs/rest/protocol), providing an ergonomic interface for appending to streams and reading data from them.

## Installation

```bash
npm add @s2-dev/streamstore
# or
yarn add @s2-dev/streamstore
# or
bun add @s2-dev/streamstore
```

## Quick start

Generate an access token from the S2 console at <https://s2.dev/dashboard>, then:

```ts
import { S2, AppendRecord } from "@s2-dev/streamstore";

const s2 = new S2({
  accessToken: process.env.S2_ACCESS_TOKEN!,
});

const basin = s2.basin("my-basin");
const stream = basin.stream("my-stream");

await stream.append([
  AppendRecord.make("Hello, world!", [["foo", "bar"]]),
]);

const result = await stream.read({ seq_num: 0, count: 10 });
console.log(result.records);
```

## More documentation

- Full SDK overview and additional examples: see the root repo README at <https://github.com/s2-streamstore/s2-sdk-typescript>.
- S2 service docs: <https://s2.dev/docs>.
