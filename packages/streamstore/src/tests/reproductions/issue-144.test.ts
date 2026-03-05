import { describe, expect, it } from "vitest";
import { EventStream, type SseMessage } from "../../lib/event-stream.js";

const encoder = new TextEncoder();

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function collectStream<T>(stream: EventStream<T>): Promise<T[]> {
  const results: T[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    results.push(value);
  }
  return results;
}

describe("Issue #144 reproduction", () => {
  it("should not drop falsy values like 0", async () => {
    const bytes = encoder.encode("data:0\n\n");
    const body = streamFromBytes(bytes);
    const stream = new EventStream<number>(body, (msg: SseMessage<string>) => {
      return { done: false, value: Number(msg.data) };
    });
    const results = await collectStream(stream);
    expect(results).toEqual([0]);
  });

  it("should correctly parse SSE lines with no colon", async () => {
    const bytes = encoder.encode("data\n\n");
    const body = streamFromBytes(bytes);
    let capturedMessage: SseMessage<string> | undefined;
    const stream = new EventStream<string>(body, (msg: SseMessage<string>) => {
      capturedMessage = msg;
      return { done: false, value: msg.data ?? "" };
    });
    const results = await collectStream(stream);
    expect(capturedMessage).toBeDefined();
    expect(capturedMessage!.data).toBe("");
    expect(results).toEqual([""]); 
  });

  it("should stop processing after done is returned", async () => {
    const bytes = encoder.encode("data:first\n\ndata:second\n\n");
    const body = streamFromBytes(bytes);
    let callCount = 0;
    const stream = new EventStream<string>(body, (msg: SseMessage<string>) => {
      callCount++;
      if (callCount === 1) {
        return { done: true };
      }
      return { done: false, value: "should-not-appear" };
    });
    const results = await collectStream(stream);
    expect(results).toEqual([]);
    expect(callCount).toBe(1);
  });
});
