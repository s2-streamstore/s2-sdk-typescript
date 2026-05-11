# Anthropic Resumable Chat with S2

A Bun server + vanilla-JS browser client that stores user messages and Anthropic SDK events in S2 so the chat can be resumed across page refreshes and disconnects.

## How it works

One S2 session stream per chat:

- A `user_message` record is written first.
- Anthropic `client.messages.stream(...)` events are written after it.
- The browser keeps a live replay open with `GET /api/chat/stream?id=...&from=N&live=1`, so another tab on the same chat URL sees new records as they are appended.

`GET /api/chat/history?id=...` returns `{ turns, messages, nextSeqNum }`. The browser renders ordered `turns` and uses `nextSeqNum` as the replay cursor.

Assistant events keep the same SSE shape as `client.messages.stream(...)`. User messages use a small `user_message` event.

## Configuration

| Field | Description |
| --- | --- |
| `S2_ACCESS_TOKEN` | S2 access token. Use `ignored` with local `s2-lite`. |
| `S2_BASIN` | Basin that stores one session stream per chat. |
| `S2_ACCOUNT_ENDPOINT` | Optional account endpoint override for `s2-lite` or custom S2 endpoints. |
| `S2_BASIN_ENDPOINT` | Optional basin endpoint override for `s2-lite` or custom S2 endpoints. |
| `ANTHROPIC_API_KEY` | Anthropic API key used by the example server. |
| `ANTHROPIC_MODEL` | Optional model override. Defaults to `claude-haiku-4-5-20251001`. |
| `ANTHROPIC_MAX_TOKENS` | Optional max token override. Defaults to `1024`. |
| `S2_CHAT_LIVE_PREFIX` | Optional stream name prefix. Defaults to `anthropic-resumable-chat`. |
| `PORT` | Optional HTTP port. Defaults to `3458`. |

## API

| Endpoint | Description |
| --- | --- |
| `POST /api/chat` | Starts a generation. Body: `{ id, message }`. Returns `202`; the stream is read from S2. |
| `GET /api/chat/stream?id=...&from=N&live=1` | Replays records from `from`; `live=1` keeps the SSE open for future turns. |
| `GET /api/chat/history?id=...` | Returns `{ turns, messages, nextSeqNum }` for initial render and replay cursor setup. |

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
