# Resumable Chat with S2 + AI SDK Transport

## How it works

This demo now uses two S2 stream shapes per chat:

1. A **transcript stream** stores completed `user` and `assistant` messages.
2. A **token stream** stores the in-flight AI SDK `UIMessageChunk`s for the current assistant turn.

The request flow is:

1. **Browser** loads `GET /api/chat/history?id=...` on startup and renders the completed transcript.
2. **Browser** sends a new user message via `POST /api/chat`.
3. **Server** appends that user message to the transcript stream, loads prior history from S2, and calls `streamText()`.
4. **Server** passes `result.toUIMessageStream()` through `chat.persist(streamName, stream)` to write the in-flight token stream to S2.
5. When the assistant finishes, the server appends the completed assistant message to the transcript stream before yielding the terminal `finish` chunk.
6. **Browser** stores the active token stream name in `sessionStorage` and reads `GET /api/chat/stream?stream=...`.
7. On page refresh, the browser reloads the transcript first and then reconnects to the in-flight token stream if one is still active.

## Run with s2-lite (local)

```bash
# terminal 1 — start s2-lite (from s2-oss/s2 repo)
cargo run -p s2-cli -- lite --port 4000

# terminal 2
export S2_ACCOUNT_ENDPOINT="http://localhost:4000"
export S2_BASIN_ENDPOINT="http://localhost:4000"
export S2_ACCESS_TOKEN="ignored"

# create a basin with auto-stream creation
s2 create-basin my-basin --create-stream-on-append

export S2_BASIN="my-basin"
export OPENAI_API_KEY="..."
bun run examples/ai-sdk-resumable-chat/server.ts
```

Open [http://localhost:3457](http://localhost:3457), send a message, hit F5 mid-generation.

## Run with S2 Cloud

```bash
export S2_ACCESS_TOKEN="..."
export S2_BASIN="my-basin"   # createStreamOnAppend must be enabled
export OPENAI_API_KEY="..."
bun run examples/ai-sdk-resumable-chat/server.ts
```

## Using with Next.js + useChat

```ts
// lib/s2.ts (server — create once)
import { createDurableChat } from "@s2-dev/resumable-stream/aisdk";

export const chat = createDurableChat({
  accessToken: process.env.S2_ACCESS_TOKEN!,
  basin: process.env.S2_BASIN!,
});
```

```ts
// app/api/chat/route.ts
import { after } from "next/server";
import { streamText } from "ai";
import { chat } from "@/lib/s2";

export async function POST(req: Request) {
  const { id, messages } = await req.json();
  const streamName = `chat-${id}-${Date.now()}`;
  return chat.persist(streamName, streamText({ model, messages }).toUIMessageStream(), {
    waitUntil: (promise) => {
      after(async () => {
        await promise;
      });
    },
  });
}
```

```tsx
// app/page.tsx
import { useChat } from "@ai-sdk/react";
import { createS2Transport } from "@s2-dev/resumable-stream/aisdk";

const transport = createS2Transport({
  api: "/api/chat",
  reconnectApi: "/api/chat/stream",
});

export default function Chat() {
  const chat = useChat({ transport, resume: true });
  // ...
}
```
