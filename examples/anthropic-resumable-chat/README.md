# Anthropic Resumable Chat with S2

A Bun server + vanilla-JS browser client that streams `client.messages.stream(...)` and persists them to S2 so they can be resumed across page refreshes and disconnects.

## How it works

Two S2 streams per chat:

| Stream | Written by | Holds |
| --- | --- | --- |
| `${HISTORY_PREFIX}-${chatId}` | Raw `@s2-dev/streamstore` (`stream.append`) | One record per chat message: `{ role: "user", content: string }` or `{ role: "assistant", content: ContentBlock[] }`. |
| `${LIVE_PREFIX}-${chatId}-${turnIdx}` | `createResumableChat` from `@s2-dev/resumable-stream/anthropic` | The raw Anthropic event sequence for one turn. One stream per turn (single-use mode). |

The server is the source of truth. The browser fetches `/api/chat/history` to render the conversation, then tails `/api/chat/stream` if a turn is in flight.

## Configuration

| Field | Description |
| --- | --- |
| `S2_ACCESS_TOKEN` | S2 access token. Use `ignored` with local `s2-lite`. |
| `S2_BASIN` | Basin that stores history + live streams. |
| `S2_ACCOUNT_ENDPOINT` | Optional account endpoint override for `s2-lite` or custom S2 endpoints. |
| `S2_BASIN_ENDPOINT` | Optional basin endpoint override for `s2-lite` or custom S2 endpoints. |
| `ANTHROPIC_API_KEY` | Anthropic API key used by the example server. |
| `ANTHROPIC_MODEL` | Optional model override. Defaults to `claude-haiku-4-5-20251001`. |
| `ANTHROPIC_MAX_TOKENS` | Optional max token override. Defaults to `1024`. |
| `S2_CHAT_HISTORY_PREFIX` | Optional history stream name prefix. Defaults to `anthropic-chat-history`. |
| `S2_CHAT_LIVE_PREFIX` | Optional live stream name prefix. Defaults to `anthropic-chat-live`. |
| `PORT` | Optional HTTP port. Defaults to `3458`. |

## API

| Endpoint | Description |
| --- | --- |
| `POST /api/chat` | Starts a generation. Body: `{ id, message }`. Returns `202`; the stream is read from S2. |
| `GET /api/chat/stream?id=...` | Replays the active turn's live stream if one exists, else `204`. |
| `GET /api/chat/history?id=...` | Returns `{ messages: ChatMessage[] }` from the history stream. |

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
