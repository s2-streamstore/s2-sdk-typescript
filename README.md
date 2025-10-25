<div align="center">
  <p>
    <!-- Light mode logo -->
    <a href="https://s2.dev#gh-light-mode-only">
      <img src="https://raw.githubusercontent.com/s2-streamstore/s2-sdk-rust/main/assets/s2-black.png" height="60">
    </a>
    <!-- Dark mode logo -->
    <a href="https://s2.dev#gh-dark-mode-only">
      <img src="https://raw.githubusercontent.com/s2-streamstore/s2-sdk-rust/main/assets/s2-white.png" height="60">
    </a>
  </p>

  <h1>TypeScript SDK for S2</h1>

  <p>
    <!-- npm -->
    <a href="https://www.npmjs.com/package/@s2-dev/streamstore"><img src="https://img.shields.io/npm/v/@s2-dev/streamstore.svg" alt="npm version" /></a>
    <!-- Discord (chat) -->
    <a href="https://discord.gg/vTCs7kMkAf"><img src="https://img.shields.io/discord/1209937852528599092?logo=discord" /></a>
  </p>
</div>

This TypeScript SDK is an ergonomic way to consume the [S2 REST API](https://s2.dev/docs/rest/protocol).

> **Note:** This is a rewrite of the TypeScript SDK. The older version (0.15.3) is still available and can be installed:
> ```bash
> npm add @s2-dev/streamstore@0.15.3
> ```
> The archived repository for the older SDK is available [here](https://github.com/s2-streamstore/s2-sdk-typescript-old).

## Getting started

1. Add the `@s2-dev/streamstore` dependency to your project:
   ```bash
   npm add @s2-dev/streamstore
   # or
   yarn add @s2-dev/streamstore
   # or
   bun add @s2-dev/streamstore
   ```

1. Generate an access token by logging onto the web console at
   [s2.dev](https://s2.dev/dashboard).

1. Make a request using SDK client.
   ```typescript
   import { S2 } from "@s2-dev/streamstore";

   const s2 = new S2({
     accessToken: process.env.S2_ACCESS_TOKEN!,
   });

   const basins = await s2.basins.list();
   console.log("My basins:", basins.basins.map((basin) => basin.name));
   ```

## Examples

The [`examples`](./examples) directory in this repository contains a variety of
example use cases demonstrating how to use the SDK effectively.

Run any example using the following command:

```bash
export S2_ACCESS_TOKEN="<YOUR ACCESS TOKEN>"
bun run examples/<example_name>.ts
# or
npx tsx examples/<example_name>.ts
```

### Example: Appending and Reading Data

```typescript
import { S2, AppendRecord } from "@s2-dev/streamstore";

const s2 = new S2({
  accessToken: process.env.S2_ACCESS_TOKEN!,
});

// Get a basin and stream
const basin = s2.basin("my-basin");
const stream = basin.stream("my-stream");

// Append records
await stream.append([
  AppendRecord.make("Hello, world!", { foo: "bar" }),
  AppendRecord.make(new Uint8Array([1, 2, 3]), { type: "binary" }),
]);

// Read records
const result = await stream.read({
  seq_num: 0,
  count: 10,
});

for (const record of result.records) {
  console.log("Record:", record.body, "Headers:", record.headers);
}

// Stream records with read session
const readSession = await stream.readSession({
  clamp: true,
  tail_offset: 10,
});

for await (const record of readSession) {
  console.log("Streaming record:", record);
}
```

>
> You might want to update the basin name in the examples before running since
> basin names are globally unique and each example uses the same basin name
> (`"my-favorite-basin"`).

## SDK Docs and Reference

For detailed documentation for the SDK, please check the generated type docs [here](https://s2-streamstore.github.io/s2-sdk-typescript/).

For API reference, please visit the [S2 Documentation](https://s2.dev/docs).

## Feedback

We use [Github Issues](https://github.com/s2-streamstore/s2-sdk-typescript/issues) to
track feature requests and issues with the SDK. If you wish to provide feedback,
report a bug or request a feature, feel free to open a Github issue.

### Contributing

Developers are welcome to submit Pull Requests on the repository. If there is
no tracking issue for the bug or feature request corresponding to the PR, we
encourage you to open one for discussion before submitting the PR.

## Reach out to us

Join our [Discord](https://discord.gg/vTCs7kMkAf) server. We would love to hear
from you.

You can also email us at [hi@s2.dev](mailto:hi@s2.dev).
