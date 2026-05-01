# TanStack AI Chat With S2 Replay

This example keeps TanStack AI in charge of chat state and model chunks. S2 is
only the durable replay layer:

- `POST /api/chat` receives TanStack `messages`, stores stream events in S2,
  and runs the model.
- `GET /api/chat/replay?id=...` tails the same S2 session stream and returns
  Server-Sent Events for `useChat`. Completed history is compacted into a
  replay-only `MESSAGES_SNAPSHOT` on page load.
- `DELETE /api/chat` stops the active in-process generation. The running
  persistence pipeline writes the final stop chunk.
- The browser uses the normal TanStack `useChat` API with an S2 connection
  adapter.

## Run

With S2 Lite:

```bash
export S2_ACCOUNT_ENDPOINT=http://localhost:8080
export S2_BASIN_ENDPOINT=http://localhost:8080
export S2_ACCESS_TOKEN=ignored
export S2_BASIN=my-basin

bun run example:tanstack-ai-chat
```

Without `OPENAI_API_KEY`, the server uses a deterministic local echo stream so
refresh and replay can be tested without a model provider.

To use real TanStack AI generation:

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4o-mini

bun run example:tanstack-ai-chat
```

## Server

Create one session helper:

```ts
import { createResumableChat } from "@s2-dev/resumable-stream/tanstack-ai";

const chat = createResumableChat({
  accessToken: process.env.S2_ACCESS_TOKEN!,
  basin: process.env.S2_BASIN!,
  mode: "session",
  enableStop: true,
});
```

Start a turn with `makeSessionResponse`:

```ts
import {
  chat as tanstackChat,
  convertMessagesToModelMessages,
} from "@tanstack/ai";
import { openaiText } from "@tanstack/ai-openai";

export async function POST(request: Request) {
  const body = await request.json();

  return chat.makeSessionResponse(`tanstack-ai-chat-${body.id}`, {
    messages: body.messages,
    source: (messages, { abortController }) =>
      tanstackChat({
        adapter: openaiText(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
        messages: convertMessagesToModelMessages(messages),
        abortController,
      }),
  });
}
```

Replay the session stream:

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
  return chat.stopSession(`tanstack-ai-chat-${id}`);
}
```

## Client

Use the S2 connection adapter with TanStack `useChat`:

```tsx
import { createS2Connection } from "@s2-dev/resumable-stream/tanstack-ai/client";
import { useChat } from "@tanstack/ai-react";
import { useMemo } from "react";

function Chat({ chatId }: { chatId: string }) {
  const connection = useMemo(
    () =>
      createS2Connection({
        mode: "session",
        sendUrl: "/api/chat",
        stopUrl: "/api/chat",
        subscribeUrl: `/api/chat/replay?id=${encodeURIComponent(chatId)}`,
        body: { id: chatId },
      }),
    [chatId],
  );

  const chat = useChat({ connection, live: true });
  const isStreaming = chat.isLoading || chat.sessionGenerating;

  function stop() {
    chat.stop();
    void connection.stop?.();
  }

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
      <button disabled={isStreaming}>Send</button>
      {isStreaming ? (
        <button type="button" onClick={stop}>
          Stop
        </button>
      ) : null}
    </form>
  );
}
```

## Files

- `src/routes/index.tsx`: React chat UI and TanStack `useChat`.
- `src/routes/api.chat.ts`: starts a generation.
- `src/routes/api.chat.replay.ts`: replays/tails the durable session stream.
- `src/server/chat.ts`: S2 setup, stream naming, and TanStack model wiring.
