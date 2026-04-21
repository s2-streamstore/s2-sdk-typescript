# Resumable Chat with S2 + AI SDK

A Bun server + vanilla-JS browser client that streams AI SDK chat turns over SSE and persists them to S2 so they can be resumed across page refreshes and disconnects.

## How it works

Two S2 streams per chat:

1. A **transcript stream** holds completed `user` / `assistant` messages.
2. A **live token stream** holds the in-flight `UIMessageChunk`s for the current assistant turn. `chat.makeResumable(...)` tees this stream: one branch goes back to the client as SSE, the other is persisted to S2 via `waitUntil`.

Request flow:

1. **Browser** loads `GET /api/chat/history?id=...` on startup and renders the completed transcript.
2. **Browser** sends a new user message via `POST /api/chat`.
3. **Server** appends the user message to the transcript stream, calls `streamText()`, passes the chunk stream to `chat.makeResumable(liveStreamName, stream)`.
4. **Server** returns the response immediately as an SSE body. The browser streams and renders chunks live; in parallel the server writes the same chunks to S2.
5. When the assistant finishes, the server appends the completed assistant message to the transcript stream.
6. **Refresh mid-generation?** The browser calls `GET /api/chat/stream?id=...`, and the server replays the active generation from S2 (tails the live chunks until the terminal fence).

## Run with s2-lite (local)

```bash
# terminal 1: start s2-lite (https://s2.dev/docs/cli)
s2 lite

# terminal 2
export S2_ACCOUNT_ENDPOINT="http://localhost:80"
export S2_BASIN_ENDPOINT="http://localhost:80"
export S2_ACCESS_TOKEN="ignored"

s2 create-basin my-basin --create-stream-on-append

export S2_BASIN="my-basin"
export OPENAI_API_KEY="..."
bun run examples/ai-sdk-resumable-chat/server.ts
```

Open [http://localhost:3457](http://localhost:3457), send a message, hit browser refresh mid-generation. The response resumes from where it left off.

## Run with S2 Cloud

```bash
export S2_ACCESS_TOKEN="..."
export S2_BASIN="my-basin"   # createStreamOnAppend must be enabled
export OPENAI_API_KEY="..."
bun run examples/ai-sdk-resumable-chat/server.ts
```

## Using with Next.js + `useChat`

The wire format (`text/event-stream` carrying `UIMessageChunk`s) matches the AI SDK's own convention, so stock `DefaultChatTransport` talks to it without a custom transport.

```ts
// lib/s2.ts (server: create once)
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
  const result = streamText({
    model: openai("gpt-4o-mini"),
    messages: await convertToModelMessages(messages),
  });
  return chat.makeResumable(`chat-${id}`, result.toUIMessageStream(), {
    waitUntil: (p) => after(async () => { await p; }),
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

const transport = new DefaultChatTransport({ api: "/api/chat" });

export default function Chat() {
  const chat = useChat({ transport, resume: true });
  // ...
}
```

`resume: true` makes `useChat` call `reconnectToStream` on mount. `DefaultChatTransport`'s default reconnect URL is `${api}/${chatId}/stream`, which matches the GET route above. If your URL shape differs, pass `prepareReconnectToStreamRequest`.
