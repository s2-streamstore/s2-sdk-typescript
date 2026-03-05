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

class FailOnSecondSubmitSession implements AppendSession {
  readonly readable = new ReadableStream<AppendAck>();
  readonly writable = new WritableStream<AppendInput>();
  private readonly acksStream: AcksStream =
    new ReadableStream<AppendAck>() as AcksStream;
  private submitCount = 0;

  async submit(input: AppendInput): Promise<BatchSubmitTicket> {
    this.submitCount++;
    if (this.submitCount >= 2) {
      throw new Error("submit failed");
    }
    const ackPromise = Promise.resolve<AppendAck>({
      start: { seqNum: 0, timestamp: new Date(0) },
      end: { seqNum: 1, timestamp: new Date(0) },
      tail: { seqNum: 1, timestamp: new Date(0) },
    });
    return new BatchSubmitTicket(ackPromise, 0, 1);
  }

  async close(): Promise<void> {}
  acks(): AcksStream { return this.acksStream; }
  lastAckedPosition(): AppendAck | undefined { return undefined; }
  failureCause(): undefined { return undefined; }
  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
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

  it("submit error rejects remaining queued inflight records", async () => {
    const session = new FailOnSecondSubmitSession();
    const producer = new Producer(
      new BatchTransform({ lingerDurationMillis: 0, maxBatchRecords: 1 }),
      session,
    );

    // Submit 3 records; second batch submit will throw.
    // The third submit may itself throw (write rejected because pump
    // cancelled the transform), or it may return a ticket whose ack rejects.
    const ticket1Promise = producer.submit(AppendRecord.string({ body: "a" }));
    const ticket2Promise = producer.submit(AppendRecord.string({ body: "b" }));
    const ticket3Promise = producer
      .submit(AppendRecord.string({ body: "c" }))
      .catch((err) => err);

    const ticket1 = await ticket1Promise;
    // First record should succeed
    const ack1 = await ticket1.ack();
    expect(ack1.seqNum()).toBe(0);

    // Second ticket's ack should reject (pump submit failed on its batch)
    const ticket2 = await ticket2Promise;
    await expect(ticket2.ack()).rejects.toThrow();

    // Third: either submit() threw (we got an Error) or ack() rejects
    const ticket3OrError = await ticket3Promise;
    if (ticket3OrError instanceof Error) {
      // submit() itself failed — record was not left hanging
      expect(ticket3OrError).toBeTruthy();
    } else {
      // submit() succeeded but ack should reject
      await expect(ticket3OrError.ack()).rejects.toThrow();
    }

    // Close should propagate the error
    await expect(producer.close()).rejects.toThrow();
  });
});
