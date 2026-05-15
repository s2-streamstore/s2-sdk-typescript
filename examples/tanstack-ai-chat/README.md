# TanStack AI Chat With S2 Replay

TanStack AI keeps chat state; S2 is the durable replay layer.

- `POST /api/chat` runs the model and persists stream chunks to S2.
- `GET /api/chat/replay?id=...&from=N` tails the same session stream as SSE for `useChat`.
- `DELETE /api/chat` aborts the active in-process generation (tracked in the example, not in the library).

## Run

With S2 Lite:

```bash
export S2_ACCOUNT_ENDPOINT=http://localhost:8080
export S2_BASIN_ENDPOINT=http://localhost:8080
export S2_ACCESS_TOKEN=ignored
export S2_BASIN=my-basin

bun run example:tanstack-ai-chat
```

Without `OPENAI_API_KEY`, a local echo stream is used so refresh/replay can be tested without a model provider.

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4o-mini

bun run example:tanstack-ai-chat
```

## Server

```ts
import { createResumableChat } from "@s2-dev/resumable-stream/tanstack-ai";

const chat = createResumableChat({
  accessToken: process.env.S2_ACCESS_TOKEN!,
  basin: process.env.S2_BASIN!,
  mode: "session",
});

// Process-local map of active turns so a DELETE route can abort the upstream
// model call. The library no longer owns this; it's plain user code.
const activeGenerations = new Map<string, AbortController>();
```

Start a turn:

```ts
import { chat as tanstackChat, convertMessagesToModelMessages } from "@tanstack/ai";
import { openaiText } from "@tanstack/ai-openai";

export async function POST(request: Request) {
  const body = await request.json();
  const name = `tanstack-ai-chat-${body.id}`;
  const active = new AbortController();
  activeGenerations.set(name, active);

  const source = tanstackChat({
    adapter: openaiText(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
    messages: convertMessagesToModelMessages(body.messages),
    abortController: active,
  });

  return chat.makeResumable(name, source, { delivery: "replay" });
}
```

Replay:

```ts
export async function GET(request: Request) {
  const url = new URL(request.url);
  return chat.replay(`tanstack-ai-chat-${url.searchParams.get("id")}`);
}
```

Stop the active generation:

```ts
export async function DELETE(request: Request) {
  const { id } = await request.json();
  activeGenerations.get(`tanstack-ai-chat-${id}`)?.abort();
  return new Response(null, { status: 202 });
}
```

## Client

```tsx
import { createConnection } from "@s2-dev/resumable-stream/tanstack-ai/client";
import { useChat } from "@tanstack/ai-react";
import { useMemo } from "react";

function Chat({ chatId }: { chatId: string }) {
  const connection = useMemo(
    () =>
      createConnection({
        sendUrl: "/api/chat",
        subscribeUrl: `/api/chat/replay?id=${encodeURIComponent(chatId)}&live=1`,
        body: { id: chatId },
      }),
    [chatId],
  );

  const chat = useChat({ connection, live: true });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const input = new FormData(form).get("message");
        if (typeof input === "string" && input.trim()) {
          chat.sendMessage(input.trim());
          form.reset();
        }
      }}
    >
      {chat.messages.map((message) => (
        <article key={message.id}>{message.role}</article>
      ))}
      <input name="message" />
      <button disabled={chat.isLoading}>Send</button>
    </form>
  );
}
```

## Files

- `src/routes/index.tsx`: React chat UI and TanStack `useChat`.
- `src/routes/api.chat.ts`: starts a generation, owns the abort map.
- `src/routes/api.chat.replay.ts`: replays/tails the durable session stream.
- `src/routes/api.chat.history.ts`: returns chat history from S2.
- `src/server/chat.ts`: S2 setup, stream naming, and TanStack model wiring.
