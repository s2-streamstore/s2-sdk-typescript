<div align="center">
  <h1>@s2-dev/durable-aisdk</h1>

  <p>
    <a href="https://discord.gg/vTCs7kMkAf"><img src="https://img.shields.io/discord/1209937852528599092?logo=discord" /></a>
    <a href="../../LICENSE"><img src="https://img.shields.io/github/license/s2-streamstore/s2-sdk-typescript" /></a>
  </p>
</div>

This package provides a durability layer for AI SDK based chats. When a user refreshes the page mid-response, the response is lost. This package fixes that by routing the stream through [S2](https://s2.dev) — the server writes chunks to an S2 stream and exposes a replay endpoint. If the connection drops, the client reconnects to the replay endpoint and picks up where it left off.

## Setup

1. Sign up at [s2.dev/dashboard](https://s2.dev/dashboard) and generate an access token.
2. Create a basin with **Create Stream on Append** enabled.
3. Install:

```bash
npm install @s2-dev/durable-aisdk @s2-dev/streamstore ai
```

Set your environment variables:

```bash
S2_ACCESS_TOKEN="..."
S2_BASIN="my-basin"
```

For local development with [s2-lite](https://github.com/s2-streamstore/s2), also set:

```bash
S2_ACCOUNT_ENDPOINT="http://localhost:{port}"
S2_BASIN_ENDPOINT="http://localhost:{port}"
```

## Quick start

### Server

Create the persistence context once and use it across requests:

```ts
// lib/s2.ts
import { createDurableChat } from "@s2-dev/durable-aisdk";

export const chat = createDurableChat({
  accessToken: process.env.S2_ACCESS_TOKEN!,
  basin: process.env.S2_BASIN!,
});
```

Handle chat requests by persisting the AI stream to S2:

```ts
// app/api/chat/route.ts
import { after } from "next/server";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { chat } from "@/lib/s2";

export async function POST(req: Request) {
  const { id, messages } = await req.json();
  const result = streamText({ model: openai("gpt-4o-mini"), messages });
  return chat.persist(id, result.fullStream, { waitUntil: after });
}
```

Add a replay endpoint so clients can read the persisted stream and resume after a refresh:

```ts
// app/api/chat/[id]/stream/route.ts
import { chat } from "@/lib/s2";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  return chat.replay(params.id);
}
```

### Client

Drop in `createS2Transport` as the transport for `useChat`:

```tsx
// app/page.tsx
import { useChat } from "ai/react";
import { createS2Transport } from "@s2-dev/durable-aisdk";

const transport = createS2Transport({ api: "/api/chat" });

export default function Chat() {
  const { messages, input, handleSubmit, handleInputChange } = useChat({
    transport,
    experimental_resume: true,
  });

  return (
    <form onSubmit={handleSubmit}>
      {messages.map((m) => (
        <div key={m.id}>{m.parts.map((p) => (p.type === "text" ? p.text : null))}</div>
      ))}
      <input value={input} onChange={handleInputChange} />
    </form>
  );
}
```

No S2 credentials or SDK needed on the client — it only talks to your server.

## How it works

### Writing (server)

1. `persist()` claims the S2 stream by appending a fence command with an empty fencing token assertion. If another writer is already active, it returns 409.
2. Each chunk from the AI SDK source is JSON-encoded and appended to S2 via a batched producer session.
3. When the source completes, a terminal fence (`end-*`) is written. On error, an `error-*` fence is written instead.
4. The response (`{ stream }`) is returned immediately when `waitUntil` is provided, or after the write completes otherwise.

### Reading (server replay)

1. `replay()` opens a read session from S2 starting at sequence number 0.
2. Fence records are skipped. Data record bodies are streamed back as NDJSON.
3. When a terminal fence is reached, the response ends.

### Reconnecting (client)

On page refresh, `useChat` calls `reconnectToStream` which hits your replay endpoint. If a generation is still in flight, the server streams the NDJSON response and the client parses it as `UIMessageChunk`s — getting all chunks including the ones it missed.

## API

### `createDurableChat(config)`

Creates a server-side persistence context.

| Option | Type | Default | Description |
|---|---|---|---|
| `accessToken` | `string` | required | S2 access token |
| `basin` | `string` | required | Basin name |
| `endpoints` | `S2Endpoints \| S2EndpointsInit` | S2 Cloud | Endpoint overrides (for s2-lite) |
| `batchSize` | `number` | `10` | Records per batch |
| `lingerDuration` | `number` | `50` | Max ms before flushing a batch |

Returns `{ persist, replay }`.

### `createS2Transport(config)`

Creates a client-side `ChatTransport` for `useChat`.

| Option | Type | Default | Description |
|---|---|---|---|
| `api` | `string` | required | Your chat API endpoint (POST) |
| `reconnectApi` | `string` | `{api}/{chatId}/stream` | Replay endpoint (GET) |
| `headers` | `HeadersInit` | — | Default headers for API requests |
| `fetchClient` | `typeof fetch` | `fetch` | Custom fetch implementation |
