import { describe, expect, it } from "vitest";
import { BatchTransform } from "../../batch-transform.js";
import { AppendRecord } from "../../index.js";
import {
  type AcksStream,
  type AppendSession,
  BatchSubmitTicket,
} from "../../lib/stream/types.js";
import { Producer } from "../../producer.js";
import { type AppendAck, type AppendInput } from "../../types.js";

class DelayedAckSession implements AppendSession {
  readonly readable = new ReadableStream<AppendAck>();
  readonly writable = new WritableStream<AppendInput>();
  private readonly acksStream: AcksStream =
    new ReadableStream<AppendAck>() as AcksStream;
  private seq = 0;
  readonly ackPromises: Promise<AppendAck>[] = [];

  async submit(input: AppendInput): Promise<BatchSubmitTicket> {
    const batch = Array.isArray(input.records)
      ? input.records
      : [input.records];
    const start = this.seq;
    this.seq += batch.length;
    const end = this.seq;

    // Ack resolves after a delay (simulating network latency)
    const ackPromise = new Promise<AppendAck>((resolve) => {
      setTimeout(() => {
        resolve({
          start: { seqNum: start, timestamp: new Date(0) },
          end: { seqNum: end, timestamp: new Date(0) },
          tail: { seqNum: end, timestamp: new Date(0) },
        });
      }, 50);
    });
    this.ackPromises.push(ackPromise);

    return new BatchSubmitTicket(ackPromise, 0, batch.length);
  }

  async close(): Promise<void> {}

  acks(): AcksStream {
    return this.acksStream;
  }

  lastAckedPosition(): AppendAck | undefined {
    return undefined;
  }

  failureCause(): undefined {
    return undefined;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

describe("Issue #138: Producer.runPump exits before awaiting acks", () => {
  it("close() waits for all pending acks to resolve", async () => {
    const session = new DelayedAckSession();
    const producer = new Producer(
      new BatchTransform({ lingerDurationMillis: 0, maxBatchRecords: 1 }),
      session,
    );

    // Submit records whose acks will be delayed
    const tickets = [];
    for (let i = 0; i < 3; i++) {
      tickets.push(
        producer.submit(AppendRecord.string({ body: "rec-" + i })),
      );
    }

    const submittedTickets = await Promise.all(tickets);

    // Close the producer - should wait for all acks
    await producer.close();

    // All acks should be resolvable (not rejected)
    for (const ticket of submittedTickets) {
      const ack = await ticket.ack();
      expect(ack.seqNum()).toBeGreaterThanOrEqual(0);
    }
  });

  it("readable stream receives all acks before closing", async () => {
    const session = new DelayedAckSession();
    const producer = new Producer(
      new BatchTransform({ lingerDurationMillis: 0, maxBatchRecords: 1 }),
      session,
    );

    const tickets = [];
    for (let i = 0; i < 3; i++) {
      tickets.push(
        producer.submit(AppendRecord.string({ body: "rec-" + i })),
      );
    }
    await Promise.all(tickets);

    // Start reading before close
    const reader = producer.readable.getReader();
    const acks = [];

    // Close in the background
    const closePromise = producer.close();

    // Read all acks
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      acks.push(value);
    }

    await closePromise;
    expect(acks.length).toBe(3);
  });
});
