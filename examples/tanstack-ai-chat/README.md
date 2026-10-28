# TanStack AI Chat With S2 Replay

TanStack AI keeps chat state; S2 is the durable replay layer.

- `POST /api/chat` runs the model and persists stream chunks to S2.
- `GET /api/chat/replay?id=...&from=N` tails the same session stream as SSE for `useChat`.
- `DELETE /api/chat` stops the active generation through S2 and aborts the upstream model call.

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
```

Start a turn:

```ts
import { chat as tanstackChat, convertMessagesToModelMessages } from "@tanstack/ai";
import { openaiText } from "@tanstack/ai-openai";

export async function POST(request: Request) {
  const body = await request.json();
  const name = `tanstack-ai-chat-${body.id}`;
  const source = (signal: AbortSignal) => {
    const abortController = new AbortController();
    const abort = () => abortController.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    return tanstackChat({
      adapter: openaiText(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
      messages: convertMessagesToModelMessages(body.messages),
      threadId: body.id,
      abortController,
    });
  };

  return chat.makeResumable(name, source, {
    delivery: "replay",
    waitUntil: (p) => p.catch(console.error),
  });
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
  await chat.stop(`tanstack-ai-chat-${id}`);
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
- `src/routes/api.chat.ts`: starts and stops generations.
- `src/routes/api.chat.replay.ts`: replays/tails the durable session stream.
- `src/server/chat.ts`: S2 setup, stream naming, and TanStack model wiring.
