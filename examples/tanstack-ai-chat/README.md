# TanStack AI Chat with S2

A Bun server + vanilla-JS browser client that stores a TanStack AI session log in
S2. The browser app appends a user turn, tails assistant events from the returned
`seqNum`, and reloads from `snapshot()` after a refresh.

## How It Works

One S2 stream per chat:

1. `POST /api/chat` reads the current S2 snapshot, appends the new user message,
   starts a TanStack AI run, and returns `{ streamName, runId, nextSeqNum }`.
2. The browser calls `GET /api/chat/tail?id=...&fromSeqNum=...` and renders
   `chunk` events for that `runId`.
3. `GET /api/chat/snapshot?id=...` materializes messages and returns the next
   resume coordinate. On refresh, the browser renders the snapshot and tails any
   active run.

The example uses a local fallback stream unless `OPENAI_API_KEY` is set. With
`OPENAI_API_KEY`, it dynamically imports `@tanstack/ai` and
`@tanstack/ai-openai`.

## Run With S2 Lite

```bash
# terminal 1
s2 lite --port 8080

# terminal 2
export S2_ACCOUNT_ENDPOINT="http://localhost:8080"
export S2_BASIN_ENDPOINT="http://localhost:8080"
export S2_ACCESS_TOKEN="ignored"

s2 create-basin tanstack-ai-chat

export S2_BASIN="tanstack-ai-chat"
bun run examples/tanstack-ai-chat/server.ts
```

Open [http://localhost:3458](http://localhost:3458).

## Run With S2 Cloud

```bash
export S2_ACCESS_TOKEN="..."
export S2_BASIN="my-basin"

bun run examples/tanstack-ai-chat/server.ts
```

## Optional Real Model Mode

```bash
bun add @tanstack/ai @tanstack/ai-openai
export OPENAI_API_KEY="sk-..."
export OPENAI_MODEL="gpt-4o-mini"

bun run examples/tanstack-ai-chat/server.ts
```

## Tuning

```bash
# Fallback echo delay per word. Set to 0 for instant local echo.
export S2_TANSTACK_ECHO_DELAY_MS=12

# S2 session persistence batching. Lower linger favors latency.
export S2_TANSTACK_SESSION_BATCH_SIZE=16
export S2_TANSTACK_SESSION_LINGER_MS=5
```
