## Initial setup

Get an API key from s2.dev (it's free to get started).

```bash
export S2_ACCESS_TOKEN="MY_TOKEN"
```

Create a basin.

```bash
export S2_BASIN="example-$(xxd -l 4 -p /dev/random)"
echo $S2_BASIN
```

This can be done with the S2 CLI:

```bash
s2 create-basin "${S2_BASIN}" --create-stream-on-append
```

## Running examples

With `S2_BASIN` and `S2_ACCESS_TOKEN` set, try running an example:

```bash
npx tsx producer.ts
```

Some examples require additional variables

### AI SDK examples

These require model provider API keys.

#### Agent session

An example agent session involving inference and tool use, where all results are stored on a per-session stream in real time.

The stream can be followed (by a dashboard or CLI, where the stream is consumed live), or audited later.

```bash
export OPENAI_API_KEY="sk-proj-XXXXX"
npx tsx ai-sdk-agent-session.ts
```

#### Chat persistence

A multi-turn chatbot where the full conversation is persisted on an S2 stream. On restart, the conversation history is replayed from the stream so the model retains full context.

```bash
export OPENAI_API_KEY="sk-proj-XXXXX"
npx tsx ai-sdk-chat-persistence.ts
```

#### Dinner party

A multi-agent conversation where N guests (each an LLM with a distinct persona) sit around a table and discuss a topic. Each guest has their own S2 stream for working memory, and they communicate through a shared bus stream. The conversation is fully resumable.

```bash
export OPENAI_API_KEY="sk-proj-XXXXX"
npx tsx ai-sdk-dinner-party.ts "What is the meaning of life?"
```
