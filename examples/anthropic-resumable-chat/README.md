# Anthropic Resumable Chat with S2

A Bun server + vanilla-JS browser client that streams Anthropic SDK chat turns over Anthropic-native SSE and persists them to S2 so they can be resumed across page refreshes and disconnects.

## How it works

Two S2 streams per chat:

- **Live (`mode: "session"`)** — `client.messages.stream(...)` events, one record each, persisted via `chat.makeResumable(...)`. Replay (`GET /api/chat/stream?id=...&from=N`) tails the active turn from a cursor; the browser picks up mid-generation after a refresh.
- **Users (append-only)** — one record per user message text. The server appends before kicking off Anthropic and reads it on `/api/chat/history` so refreshes show the full conversation.

`GET /api/chat/history?id=...` returns `{ users: string[], messages: Message[], nextSeqNum }`. The browser interleaves users with reconstructed assistants and uses `nextSeqNum` as the replay cursor.

Wire format on both the live response and replay is byte-compatible with what `client.messages.stream(...)` produces, so any SSE parser works (we use `eventsource-parser` in the example).

## Run with s2-lite (local)

```bash
# terminal 1: start s2-lite (https://s2.dev/docs/cli)
s2 lite

# terminal 2
export S2_ACCOUNT_ENDPOINT="http://localhost:8080"
export S2_BASIN_ENDPOINT="http://localhost:8080"
export S2_ACCESS_TOKEN="ignored"

s2 create-basin my-basin --create-stream-on-append --create-stream-on-read

export S2_BASIN="my-basin"
export ANTHROPIC_API_KEY="..."
bun run examples/anthropic-resumable-chat/server.ts
```

Open [http://localhost:3458](http://localhost:3458), send a message, hit `F5` mid-generation. The response resumes from where it left off.

## Run with S2 Cloud

```bash
export S2_ACCESS_TOKEN="..."
export S2_BASIN="my-basin"   # createStreamOnAppend + createStreamOnRead
export ANTHROPIC_API_KEY="..."
bun run examples/anthropic-resumable-chat/server.ts
```

