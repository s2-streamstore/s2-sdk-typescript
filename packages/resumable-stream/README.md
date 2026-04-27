<div align="center">
  <h1>@s2-dev/resumable-stream</h1>
  <p>Resumable streams based on s2.dev, inspired by Vercel's implementation.</p>

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

The package exposes two entry points:

- **`@s2-dev/resumable-stream`**: a generic `ReadableStream<string>` resumer (`createResumableStreamContext`). Use for plain text streams or anything that isn't AI SDK.
- **`@s2-dev/resumable-stream/aisdk`**: a thin helper over `UIMessageChunk` streams for the AI SDK's `useChat`. See the [AI SDK section](#ai-sdk) below.
- **`@s2-dev/resumable-stream/tanstack-ai`**: a thin helper over TanStack AI `StreamChunk` streams. See the [TanStack AI section](#tanstack-ai) below.

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

The `./aisdk` subpath makes AI SDK `useChat` streams resumable via S2. `makeResumable` tees the `UIMessageChunk` stream: one branch streams directly back to the client as SSE, the other is persisted to S2 for resumption. The wire format matches the AI SDK's `createUIMessageStreamResponse`, so the stock `DefaultChatTransport` works out of the box.

A runnable end-to-end demo (Bun server + vanilla-JS client) lives in [`examples/ai-sdk-resumable-chat`](../../examples/ai-sdk-resumable-chat/).

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
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { openai } from "@ai-sdk/openai";
import { chat } from "@/lib/s2";

export async function POST(req: Request) {
  const { id, messages } = (await req.json()) as { id: string; messages: UIMessage[] };
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

## TanStack AI

The `./tanstack-ai` subpath has two layers:

- `createResumableGeneration()` makes a single TanStack AI `StreamChunk` generation resumable through S2.
- `createS2SessionHandler()` and `createS2Connection()` implement an S2 session log: append new user messages, tail assistant events from a `seqNum`, and materialize message history plus the next resume coordinate with `snapshot()`.

```ts
import { chat } from "@tanstack/ai";
import { openaiText } from "@tanstack/ai-openai";
import {
  createS2Connection,
  createS2SessionHandler,
} from "@s2-dev/resumable-stream/tanstack-ai";

const handler = createS2SessionHandler({
  accessToken: process.env.S2_ACCESS_TOKEN!,
  basin: process.env.S2_BASIN!,
  async produce({ messages }) {
    return chat({
      adapter: openaiText("gpt-4o-mini"),
      messages,
    });
  },
});

export async function POST(req: Request) {
  // Appends new user messages and starts a background model run.
  return handler.POST(req);
}

export async function GET(req: Request) {
  // Tails session events from ?streamName=...&fromSeqNum=...
  return handler.GET(req);
}

export const connection = createS2Connection({
  appendUrl: "/api/chat/append",
  tailUrl: "/api/chat/tail",
  streamName: "tanstack-ai/session-1",
});
```

The session stream stores user messages, run starts, assistant chunks, run finishes, and run errors as ordered S2 records. A runnable browser chat example lives in [`examples/tanstack-ai-chat`](../../examples/tanstack-ai-chat). It uses a local fallback stream by default, or a real TanStack AI + OpenAI stream when `OPENAI_API_KEY` is set and `@tanstack/ai @tanstack/ai-openai` are installed.
