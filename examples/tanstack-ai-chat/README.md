# TanStack AI Chat With S2 Resume

A TanStack Start app that streams TanStack AI chunks through S2-backed resumable SSE routes.

## Run

```bash
export S2_ACCOUNT_ENDPOINT=http://localhost:8080
export S2_BASIN_ENDPOINT=http://localhost:8080
export S2_ACCESS_TOKEN=ignored
export S2_BASIN=my-basin

bun run example:tanstack-ai-chat
```

Open [http://127.0.0.1:3458](http://127.0.0.1:3458).

Without `OPENAI_API_KEY`, the app uses a deterministic local stream so resume can be tested without a model provider. To use real TanStack AI generation:

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4o-mini
bun run example:tanstack-ai-chat
```

## Shape

- `src/routes/index.tsx` is the React chat route.
- `src/routes/api.chat.ts` starts a generation and returns the live SSE stream.
- `src/routes/api.chat.replay.ts` replays the active S2 generation after a refresh.
- `src/routes/api.chat.history.ts` reloads completed transcript messages.
- `src/server/chat.ts` contains S2 stream creation, transcript persistence, and TanStack AI source creation.
