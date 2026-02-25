# AI SDK Demo

How to use S2 as a durable memory layer for AI applications, built with the [Vercel AI SDK](https://sdk.vercel.ai).

## Examples

- **Chat Persistence** — a chat UI where conversation history is stored in an S2 stream. Click Restart to clear in-memory state and watch it restore from S2.
- **Agent Audit Trail** — runs an AI agent with tool use and records every step to S2. Each run gets its own stream, providing a permanent audit log.
- **Dinner Party** — a multi-agent conversation where Socrates, Freud, and Genghis Khan discuss a topic. Each guest has their own S2 memory stream, a shared bus stream coordinates turns.

## Setup

```bash
export S2_ACCESS_TOKEN="your-s2-token"
export S2_BASIN="your-basin"
export OPENAI_API_KEY="your-openai-key"
```

## Run

```bash
bun run examples/ai-sdk-examples/server.ts
```

Then open [http://localhost:3456](http://localhost:3456).

## Options

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3456` | HTTP port |
| `AI_SDK_MAX_CONTEXT_MESSAGES` | `40` | Max messages kept in context per session |
