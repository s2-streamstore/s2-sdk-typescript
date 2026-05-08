# Anthropic Resumable Chat with S2

A Bun server + vanilla-JS browser client that streams Anthropic SDK chat turns over Anthropic-native SSE and persists them to S2 so they can be resumed across page refreshes and disconnects.

## How it works

One S2 stream per chat, using `mode: "session"`:

- Each user turn calls `client.messages.stream(...)` and pipes its `RawMessageStreamEvent`s into `chat.makeResumable(...)`. One event per record.
- Replay (`GET /api/chat/stream?id=...`) tails the active turn from S2 — the browser picks up mid-generation after a refresh.
- History (`GET /api/chat/history?id=...`) returns prior closed turns as Anthropic `Message[]`, reconstructed via the in-house accumulator.

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

## Note on persisting user messages

This demo only persists the assistant turns (one per `messages.stream` call). When rebuilding the conversation for a new turn, it loads prior assistant `Message`s from `chat.history()` and pairs them with the live user message.

A real app should also persist user messages — either:
- Append them to a side stream (`s2.basin(b).stream(streamName).append(...)` with a `user-message` header, then filter in your history loader); or
- Track them client-side and submit the full `messages` array on each POST.

The first approach keeps S2 as the single source of truth; the second matches how most chat UIs already work.
