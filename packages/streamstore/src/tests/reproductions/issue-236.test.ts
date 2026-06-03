import { describe, expect, it } from "vitest";
import { BatchTransform } from "../../batch-transform.js";
import { FencingTokenMismatchError } from "../../error.js";
import { AppendRecord } from "../../index.js";
import {
	type AcksStream,
	type AppendSession,
	BatchSubmitTicket,
} from "../../lib/stream/types.js";
import { Producer } from "../../producer.js";
import { type AppendAck, type AppendInput } from "../../types.js";

/**
 * Issue #236: after a pump failure, submit() wrapped the error in a generic
 * S2Error while close() rethrew the original, so takeover errors lost their
 * FencingTokenMismatchError type. The fix rethrows the original from both.
 */

/** An append session that rejects every submit with a fencing mismatch. */
class FencedAppendSession implements AppendSession {
	readonly readable = new ReadableStream<AppendAck>();
	readonly writable = new WritableStream<AppendInput>();
	private readonly acksStream: AcksStream =
		new ReadableStream<AppendAck>() as AcksStream;

	constructor(private readonly error: FencingTokenMismatchError) {}

	async submit(_input: AppendInput): Promise<BatchSubmitTicket> {
		throw this.error;
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

function makeProducer(error: FencingTokenMismatchError): Producer {
	return new Producer(
		new BatchTransform({ lingerDurationMillis: 0, maxBatchRecords: 1 }),
		new FencedAppendSession(error),
	);
}

describe("Issue #236: submit() preserves the pump error type", () => {
	it("rethrows the original FencingTokenMismatchError from later submits", async () => {
		const fencing = new FencingTokenMismatchError({
			message: "fencing token mismatch",
			expectedFencingToken: "other-writer",
		});
		const producer = makeProducer(fencing);

		// First submit is accepted; its ack rejects with the pump error.
		const ticket = await producer.submit(AppendRecord.string({ body: "a" }));
		await expect(ticket.ack()).rejects.toBe(fencing);

		// Later submits must surface the same error, not a generic wrapper.
		await expect(
			producer.submit(AppendRecord.string({ body: "b" })),
		).rejects.toBe(fencing);

		// close() already rethrew the original; both paths now agree.
		await expect(producer.close()).rejects.toBe(fencing);
	});

	it("keeps the error recognizable via instanceof across submit and close", async () => {
		const fencing = new FencingTokenMismatchError({
			message: "fencing token mismatch",
			expectedFencingToken: "other-writer",
		});
		const producer = makeProducer(fencing);

		const ticket = await producer.submit(AppendRecord.string({ body: "a" }));
		await ticket.ack().catch(() => {});

		const errors: unknown[] = [];
		try {
			await producer.submit(AppendRecord.string({ body: "fence" }));
		} catch (err) {
			errors.push(err);
		}
		try {
			await producer.close();
		} catch (err) {
			errors.push(err);
		}

		expect(errors).toHaveLength(2);
		// The adapter's takeover predicate must hold for every member.
		expect(
			errors.every((err) => err instanceof FencingTokenMismatchError),
		).toBe(true);
	});
});
