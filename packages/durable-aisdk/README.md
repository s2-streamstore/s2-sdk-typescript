<div align="center">
  <h1>@s2-dev/durable-aisdk</h1>

  <p>
    <a href="https://discord.gg/vTCs7kMkAf"><img src="https://img.shields.io/discord/1209937852528599092?logo=discord" /></a>
    <a href="../../LICENSE"><img src="https://img.shields.io/github/license/s2-streamstore/s2-sdk-typescript" /></a>
  </p>
</div>

This package provides a durability layer for AI SDK based chats, for example, when a user refreshes the page mid response, the response is lost. This package fixes that by routing the stream through [S2](https://s2.dev) as the server writes chunks to an S2 stream, and the client reads them back directly over SSE. If the connection drops, the client reconnects to the same S2 stream and picks up where it left off.

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

Add a reconnect endpoint so clients can resume after a refresh:

```ts
// app/api/chat/[id]/stream/route.ts
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const streamName = getActiveStream(params.id); // your lookup
  if (!streamName) return new Response(null, { status: 204 });
  return Response.json({ stream: streamName });
}
```

### Client

Drop in `createS2Transport` as the transport for `useChat`:

```tsx
// app/page.tsx
import { useChat } from "ai/react";
import { createS2Transport } from "@s2-dev/durable-aisdk";

const transport = createS2Transport({
  api: "/api/chat",
  s2: {
    accessToken: process.env.NEXT_PUBLIC_S2_READ_TOKEN!,
    basin: "my-basin",
  },
});

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

## How it works

### Writing (server)

1. `persist()` claims the S2 stream by appending a fence command with an empty fencing token assertion. If another writer is already active, it returns 409.
2. Each chunk from the AI SDK source is JSON-encoded and appended to S2 via a batched producer session.
3. When the source completes, a terminal fence (`end-*`) is written. On error, an `error-*` fence is written instead.
4. The response (`{ stream }`) is returned immediately when `waitUntil` is provided, or after the write completes otherwise.

### Reading (client)

1. `createS2Transport` receives the stream name from your server's JSON response.
2. It opens a read session directly to S2.
3. Fence records are skipped. Data record bodies are parsed as `UIMessageChunk` and fed into `useChat`.
4. When a terminal fence is reached, the stream closes.

### Reconnecting

On page refresh, `useChat` calls `reconnectToStream` which hits your reconnect endpoint. If a generation is still in flight, the endpoint returns `{ stream }` and the client re-opens the S2 read session from the beginning getting all chunks including the ones it missed.
