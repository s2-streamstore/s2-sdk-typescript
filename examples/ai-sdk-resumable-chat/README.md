# Resumable Chat — S2 + AI SDK Transport

AI chat that survives page refreshes. The server persists every generation to S2, and the browser reads chunks **directly from S2 over SSE** — no server proxy on the read path.

Works with both **S2 Cloud** and **s2-lite** (local).

## How it works

1. **Browser** sends a message via `POST /api/chat`
2. **Server** calls `streamText()` and passes the result to `chat.persist(id, stream)` which writes chunks to S2 and responds with `{ stream: "name" }`
3. **Browser** opens an SSE connection straight to S2 and renders chunks as they arrive
4. On page refresh, the browser hits `GET /api/chat/{id}/stream` — if a generation is still in flight, the server returns `{ stream }` and the browser reconnects to S2

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

The example uses vanilla JS to show what happens under the hood. In a real app:

```ts
// lib/s2.ts (server — create once)
import { createS2ChatPersistence } from "@s2-dev/aisdk-transport";

export const chat = createS2ChatPersistence({
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
  return chat.persist(id, streamText({ model, messages }).fullStream, {
    waitUntil: after,
  });
}
```

```tsx
// app/page.tsx
import { useChat } from "ai/react";
import { createS2ChatTransport } from "@s2-dev/aisdk-transport";

const transport = createS2ChatTransport({
  api: "/api/chat",
  s2: {
    accessToken: process.env.NEXT_PUBLIC_S2_READ_TOKEN!,
    basin: "my-basin",
    // For s2-lite, set baseUrl: "http://localhost:4000/v1"
  },
});

export default function Chat() {
  const chat = useChat({ transport, experimental_resume: true });
  // ...
}
```
