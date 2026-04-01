<div align="center">
  <h1>@s2-dev/resumable-stream</h1>
  <p>Resumable streams based on s2.dev, inspired by Vercel's implementation.</p>

  <p>
    <!-- Discord (chat) -->
    <a href="https://discord.gg/vTCs7kMkAf"><img src="https://img.shields.io/discord/1209937852528599092?logo=discord" /></a>
    <!-- LICENSE -->
    <a href="../../LICENSE"><img src="https://img.shields.io/github/license/s2-streamstore/s2-sdk-typescript" /></a>
  </p>
</div>

This package is inspired by Vercel's take on [Resumable Streams](https://github.com/vercel/resumable-stream) used in the Chat SDK, except instead of Redis, this relies on [S2](http://s2.dev/) to create and resume streams.

Try it out [here](https://ai-chatbot-s2.vercel.app/).

## Usage

To use this package, you need to create an S2 [access token](https://s2.dev/docs/access-control) and basin to store all your streams.

1. Sign up [here](https://s2.dev/dashboard), generate an access token and set it as `S2_ACCESS_TOKEN` in your env.

2. Create a new basin from the `Basins` tab with the `Create Stream on Append` and `Create Stream on Read` option enabled, and set it as `S2_BASIN` in your env.

The incoming stream is batched and the batch size can be changed by setting `S2_BATCH_SIZE`. The maximum time to wait before flushing a batch can be tweaked by setting `S2_LINGER_DURATION` to a duration in milliseconds.

To integrate this package with the Chat SDK, just update your imports to use this package or check [this](https://github.com/s2-streamstore/ai-chatbot) fork.

```ts
import { createResumableStreamContext } from "@s2-dev/resumable-stream";
import { after } from "next/server";

const streamContext = createResumableStreamContext({
  waitUntil: after,
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ streamId: string }> }) {
  const { streamId } = await params;
  const inputStream = makeTestStream();
  const stream = await streamContext.resumableStream(
    streamId,
    () => inputStream,
  );
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
    },
  });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ streamId: string }> }) {
  const { streamId } = await params;
  const stream = await streamContext.resumeStream(
    streamId,
  );
  if (!stream) {
    return new Response("Stream is already done", {
      status: 422,
    });
  }
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
    },
  });
}
```

## How it works

### Creation
1. The input stream is immediately duplicated into two identical streams.
2. One stream is returned to the caller for immediate consumption and the other stream is processed asynchronously:
   - An initial fence command is appended to the S2 stream with a unique session token, claiming ownership of the stream to prevent any races. S2 streams are created on the first append (configured at the basin level).
   - Data is continuously batched and flushed as it is read from the duplicated input stream to the S2 stream when the batch is full or a timeout occurs.
   - When the input stream completes, a final fence command marking the stream as done is appended.

### Resumption
1. A caller requests to resume an existing stream by ID.
2. A stream is returned that reads data from the S2 stream and processes it:
   - Data is read from the S2 stream from the beginning. S2 streams are also created on read (configured at the basin level) if a read happens before an append to prevent any races.
   - Data records are enqueued to the output stream controller for consumption.
   - If a sentinel fence command is encountered, the stream is closed.
