<div align="center">
  <h1>@s2-dev/resumable-stream</h1>
  <p>Resumable streams backed by S2.</p>

  <p>
    <!-- Discord (chat) -->
    <a href="https://discord.gg/vTCs7kMkAf"><img src="https://img.shields.io/discord/1209937852528599092?logo=discord" /></a>
    <!-- LICENSE -->
    <a href="../../LICENSE"><img src="https://img.shields.io/github/license/s2-streamstore/s2-sdk-typescript" /></a>
  </p>
</div>

## Usage

To use this package, you need to create an S2 [access token](https://s2.dev/docs/access-control) and basin to store all your streams.

1. Sign up [here](https://s2.dev/dashboard), generate an access token and set it as `S2_ACCESS_TOKEN` in your env.

2. Create a new basin from the `Basins` tab with the `Create Stream on Append` and `Create Stream on Read` option enabled, and set it as `S2_BASIN` in your env.

The incoming stream is batched and the batch size can be changed by setting `S2_BATCH_SIZE`. The maximum time to wait before flushing a batch can be tweaked by setting `S2_LINGER_DURATION_MS` to a duration in milliseconds.

The package exposes these entry points:

- **`@s2-dev/resumable-stream`**: a generic `ReadableStream<string>` resumer (`createResumableStreamContext`). Use for plain text streams or anything that isn't AI SDK.
- **`@s2-dev/resumable-stream/aisdk`**: a thin helper over `UIMessageChunk` streams for the AI SDK's `useChat`. See the [AI SDK section](#ai-sdk) below.
- **`@s2-dev/resumable-stream/anthropic`**: persists and replays raw `client.messages.stream(...)` events. See the [Anthropic section](#anthropic) below.
- **`@s2-dev/resumable-stream/anthropic/client`**: browser helpers for subscribing to and reconnecting against the replay.
- **`@s2-dev/resumable-stream/tanstack-ai`**: a thin helper over TanStack AI `StreamChunk` streams. See the [TanStack AI section](#tanstack-ai) below.
- **`@s2-dev/resumable-stream/tanstack-ai/client`**: TanStack AI client helpers.

### Generic resumer

```ts
import { createResumableStreamContext } from "@s2-dev/resumable-stream";
import { after } from "next/server";

const streamContext = createResumableStreamContext({
  waitUntil: (promise) => {
    after(async () => {
      await promise;
    });
  },
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ streamId: string }> }) {
  const { streamId } = await params;
  const inputStream = makeTestStream();
  const stream = await streamContext.resumableStream(
    streamId,
    () => inputStream,
  );
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
    },
  });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ streamId: string }> }) {
  const { streamId } = await params;
  const stream = await streamContext.resumeStream(
    streamId,
  );
  if (!stream) {
    return new Response("Stream is already done", {
      status: 422,
    });
  }
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
    },
  });
}
```

## How it works

### Creation
1. The input stream is immediately duplicated into two identical streams.
2. One stream is returned to the caller for immediate consumption and the other stream is processed asynchronously:
   - An initial fence command is appended to the S2 stream with a unique session token, claiming ownership of the stream to prevent any races. S2 streams are created on the first append (configured at the basin level).
   - Data is continuously batched and flushed as it is read from the duplicated input stream to the S2 stream when the batch is full or a timeout occurs.
   - When the input stream completes, a final fence command marking the stream as done is appended.

### Resumption
1. A caller requests to resume an existing stream by ID.
2. A stream is returned that reads data from the S2 stream and processes it:
   - Data is read from the S2 stream from the beginning. S2 streams are also created on read (configured at the basin level) if a read happens before an append to prevent any races.
   - Data records are enqueued to the output stream controller for consumption.
   - If a sentinel fence command is encountered, the stream is closed.

## AI SDK

The `./aisdk` subpath makes AI SDK `useChat` streams resumable via S2. `makeResumable` writes `UIMessageChunk`s to S2 and streams the response by reading those records. The wire format matches the AI SDK's `createUIMessageStreamResponse`, so the stock `DefaultChatTransport` works out of the box.

A runnable end-to-end demo (Bun server + vanilla-JS client): [`examples/ai-sdk-resumable-chat`](../../examples/ai-sdk-resumable-chat/).

```ts
// lib/s2.ts
import { createResumableChat } from "@s2-dev/resumable-stream/aisdk";

export const chat = createResumableChat({
  accessToken: process.env.S2_ACCESS_TOKEN!,
  basin: process.env.S2_BASIN!,
});
```

```ts
// app/api/chat/route.ts
import { after } from "next/server";
import { convertToModelMessages, streamText, type UISnapshotMessage } from "ai";
import { openai } from "@ai-sdk/openai";
import { chat } from "@/lib/s2";

export async function POST(req: Request) {
  const { id, messages } = (await req.json()) as { id: string; messages: UISnapshotMessage[] };
  const streamName = `chat-${id}`;
  const result = streamText({
    model: openai("gpt-4o-mini"),
    messages: await convertToModelMessages(messages),
  });

  return chat.makeResumable(streamName, result.toUIMessageStream(), {
    waitUntil: (promise) => {
      after(async () => {
        await promise;
      });
    },
  });
}
```

```ts
// app/api/chat/[id]/stream/route.ts
import { chat } from "@/lib/s2";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return chat.replay(`chat-${id}`);
}
```

```tsx
// app/page.tsx
"use client";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

const transport = new DefaultChatTransport({
  api: "/api/chat",
  // `DefaultChatTransport` defaults reconnect to `${api}/${chatId}/stream`;
  // override via `prepareReconnectToStreamRequest` if your route shape differs.
});

export default function Chat() {
  const chat = useChat({ transport, resume: true });
  return null;
}
```

## Anthropic

The `./anthropic` subpath persists raw `client.messages.stream(...)` events to
S2 and replays them as SSE that matches the Anthropic wire format:

```
event: <event_type>
data:  <json>
id:    <seqNum>
```

That's the entire mission. Chat history, message reconstruction, and prompt
assembly stay in your application — pair this with the SDK's
[`MessageStream`](https://github.com/anthropics/anthropic-sdk-typescript) or
your own folding logic to turn replayed events back into a `Message`.

A runnable end-to-end demo (Bun server + vanilla-JS client maintaining its own
chat state in `localStorage`): [`examples/anthropic-resumable-chat`](../../examples/anthropic-resumable-chat/).

For chat apps, use `mode: "session"` and read responses from a replay route:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { createResumableChat } from "@s2-dev/resumable-stream/anthropic";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const chat = createResumableChat({
  accessToken: process.env.S2_ACCESS_TOKEN!,
  basin: process.env.S2_BASIN!,
  mode: "session",
});

export async function POST(req: Request) {
  const { id, messages } = await req.json();
  const source = anthropic.messages.stream({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages,
  });

  return chat.makeResumable(`chat-${id}`, source, {
    delivery: "replay",
    waitUntil: (p) => p.catch(console.error),
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  return chat.replay(`chat-${url.searchParams.get("id")}`, {
    fromSeqNum: url.searchParams.has("from")
      ? Number(url.searchParams.get("from"))
      : undefined,
    live: url.searchParams.get("live") === "1",
  });
}
```

The browser helper is a single async generator. POSTs are plain `fetch`;
`subscribe` handles the SSE tail, cursor tracking, and auto-reconnect with
`?from=<seqNum>` on body drop:

```ts
import { subscribe } from "@s2-dev/resumable-stream/anthropic/client";

const ac = new AbortController();

await fetch("/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ id: chatId, message: "hi" }),
});

for await (const event of subscribe({
  url: (cursor) => `/api/chat/stream?id=${chatId}&from=${cursor ?? 0}&live=1`,
  signal: ac.signal,
})) {
  // Anthropic events plus the adapter's `error` envelope.
}
```

The loop ends on body close followed by HTTP 204 from a reconnect, on an
aborted `signal`, or when `reconnectBackoffMs: []` is passed and the body
ends without 204.

Server fields:

| Field | Description |
| --- | --- |
| `accessToken` | S2 access token. |
| `basin` | S2 basin that stores chat streams. |
| `endpoints` | Optional S2 endpoint overrides, commonly used with `s2-lite`. |
| `mode` | Storage layout: `single-use`, `shared`, or `session`. Use `session` for multi-turn chats and multi-tab replay. |
| `batchSize` | Maximum number of chunks to append to S2 at once. Defaults to `10`. |
| `lingerDuration` | Maximum batching delay in milliseconds. Defaults to `50`. |
| `leaseDurationMs` | `shared` mode takeover window for stale active generations. Defaults to `5000`. |
| `onError` | Maps upstream errors to the stored/rendered error message. |

`makeResumable` fields:

| Field | Description |
| --- | --- |
| `delivery` | `response` streams on the POST response; `replay` returns `202` and expects clients to read from `replay`. Defaults to `response`. |
| `waitUntil` | Keeps persistence running after the response returns in serverless runtimes. |

`replay` fields:

| Field | Description |
| --- | --- |
| `fromSeqNum` | S2 cursor to resume from. The client tracks this automatically via SSE `id:`. |
| `live` | `session` mode only. Keeps the SSE open at the tail for future turns. |

`subscribe` options:

| Field | Description |
| --- | --- |
| `url` | Replay URL. String URLs get `?from=<cursor>` appended on reconnect; function URLs receive the cursor. |
| `signal` | Optional abort signal. |
| `fetch` | Optional fetch implementation override. |
| `headers` | Static or lazy headers sent on every request. |
| `credentials` | Fetch credentials mode. Defaults to `same-origin`. |
| `reconnectBackoffMs` | Millisecond backoff schedule for reconnects. Pass `[]` to disable reconnect. |

## TanStack AI

The `./tanstack-ai` subpath makes TanStack AI chat streams durable as S2 stores and replays the stream chunks
on reconnects.

For full chat apps, use `mode: "session"`:

- `POST` starts a generation and appends chunks to one durable S2 session log.
- `GET` replays completed history and tails live chunks as SSE.
- `DELETE` stops the active in-process generation; that generation writes its
  own `RUN_FINISHED` stop chunk while closing.

Configure the S2 basin to create streams on append/read. Streams are not
created before replay or generation.

```ts
import {
  chat as tanstackChat,
  convertMessagesToModelMessages,
} from "@tanstack/ai";
import { openaiText } from "@tanstack/ai-openai";
import { createResumableChat } from "@s2-dev/resumable-stream/tanstack-ai";

const chat = createResumableChat({
  accessToken: process.env.S2_ACCESS_TOKEN!,
  basin: process.env.S2_BASIN!,
  mode: "session",
  enableStop: true,
});

export async function POST(req: Request) {
  const { id, messages } = await req.json();

  return chat.makeSessionResponse(`chat-${id}`, {
    messages,
    source: (messages, { abortController }) =>
      tanstackChat({
        adapter: openaiText("gpt-4o-mini"),
        messages: convertMessagesToModelMessages(messages),
        abortController,
      }),
    waitUntil,
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  return chat.replay(`chat-${url.searchParams.get("id")}`, {
    fromSeqNum: url.searchParams.has("from")
      ? Number(url.searchParams.get("from"))
      : undefined,
  });
}

export async function DELETE(req: Request) {
  const { id } = await req.json();
  return chat.stopSession(`chat-${id}`);
}
```

The `./tanstack-ai/client` subpath exposes a `useChat` connection adapter for
those endpoints:

```tsx
import { useChat } from "@tanstack/ai-react";
import { createS2Connection } from "@s2-dev/resumable-stream/tanstack-ai/client";

const connection = createS2Connection({
  mode: "session",
  sendUrl: "/api/chat",
  stopUrl: "/api/chat",
  subscribeUrl: `/api/chat/replay?id=${chatId}`,
  body: { id: chatId },
});

const { messages, sendMessage, stop, isLoading, sessionGenerating } = useChat({
  connection,
  live: true,
});

const isGenerating = isLoading || sessionGenerating;

function stopGeneration() {
  stop();
  void connection.stop?.();
}
```

Notes:

- `makeSessionResponse` passes the submitted TanStack messages to `source`.
  It stores stream events only: the latest user text event and model chunks.
- Session starts read only the last record to claim the next turn. `stopSession`
  does not scan the stream i.e. it aborts the active local generation and lets the running
  persistence pipeline close the run.
- Local stop tracking is opt-in. Set `enableStop: true` only when this
  server instance exposes `stopSession`; otherwise no active-generation map is
  created and `stopSession` returns 204.
- Pass your platform's `waitUntil` when available. Without it,
  `makeSessionResponse` waits for persistence before returning so serverless
  runtimes do not abandon the stream after a 202 response.
- First page load compacts completed history into an in-memory
  `MESSAGES_SNAPSHOT` SSE event. Snapshots are not stored on an S2 stream.
- Replay frames carry the next S2 sequence number as the SSE `id`, so the
  client can reconnect from the last processed record.
- `stop()` only cancels TanStack's local request. Call `connection.stop?.()` to
  stop server-side generation and persistence too. This is intentionally
  explicit so refresh/unmount does not stop a run.

For request-scoped streaming, keep the default `mode: "single-use"` and call
`makeResumable`. Omit `subscribeUrl` on the client to stream chunks on the POST
response; pass `subscribeUrl` only if the client should recover an active run on
mount.

Runnable examples:

- [`examples/tanstack-ai-chat`](../../examples/tanstack-ai-chat): small local
  S2 session chat.
