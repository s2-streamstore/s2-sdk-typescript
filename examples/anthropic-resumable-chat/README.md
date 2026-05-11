# Anthropic Resumable Chat with S2

A Bun server + vanilla-JS browser client that stores user messages and Anthropic SDK events in S2 so the chat can be resumed across page refreshes and disconnects.

## How it works

One S2 session stream per chat:

- A `user_message` record is written first.
- Anthropic `client.messages.stream(...)` events are written after it.
- The browser reads the same records from `GET /api/chat/stream?id=...&from=N`.

`GET /api/chat/history?id=...` returns `{ users: string[], messages: Message[], nextSeqNum }`. The browser interleaves users with reconstructed assistants and uses `nextSeqNum` as the replay cursor.

Assistant events keep the same SSE shape as `client.messages.stream(...)`. User messages use a small `user_message` event.

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
