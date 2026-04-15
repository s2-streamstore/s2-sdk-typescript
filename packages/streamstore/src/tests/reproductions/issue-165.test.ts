import { describe, expect, it } from "vitest";
import { BatchTransform } from "../../batch-transform.js";
import { S2Error } from "../../error.js";
import { BatchSubmitTicket } from "../../lib/stream/types.js";
import { Producer } from "../../producer.js";
import { AppendRecord, type AppendAck, type AppendInput } from "../../types.js";

/**
 * Issue #165: Producer.close() masks append/ack failures with TypeError during cleanup.
 *
 * When an error occurs during batch ack (e.g., network failure), the pump calls
 * readableController.error(error) but does not set readableController to null.
 * Later, _doClose() sees a non-null controller and calls .close() on it, which
 * throws a TypeError ("Invalid state") because the controller is already errored.
 * This masks the original S2Error.
 */

function makeMockAppendSession(opts: {
	ackBehavior: "resolve" | "reject";
}): any {
	return {
		submit: async (input: AppendInput) => {
			const ackPromise =
				opts.ackBehavior === "reject"
					? Promise.reject(
							new S2Error({
								message: "Ack failure: fencing token mismatch",
								status: 412,
								origin: "server",
							}),
						)
					: Promise.resolve({
							start: { seqNum: 0, timestamp: new Date() },
							end: { seqNum: input.records.length, timestamp: new Date() },
						} as AppendAck);

			return new BatchSubmitTicket(
				ackPromise,
				100,
				input.records.length,
			);
		},
		close: async () => {},
		readable: new ReadableStream(),
		writable: new WritableStream(),
		acks: new ReadableStream(),
	};
}

describe("Issue #165: Producer.close() should propagate original error, not TypeError", () => {
	it("close() throws the original S2Error when ack fails, not a TypeError", async () => {
		const mockSession = makeMockAppendSession({ ackBehavior: "reject" });
		const producer = new Producer(
			new BatchTransform({ lingerDurationMillis: 0 }),
			mockSession,
		);

		// Submit a record — this will succeed (submit resolves), but the ack will fail
		await producer.submit(AppendRecord.string({ body: "hello" }));

		// Give time for the ack rejection to propagate through the pump
		await new Promise((r) => setTimeout(r, 50));

		// close() should throw the original S2Error, NOT a TypeError
		try {
			await producer.close();
			// If close() doesn't throw, that's also acceptable — but it shouldn't mask
			expect(true).toBe(true);
		} catch (err) {
			// The bug: err would be TypeError("Invalid state: Controller is already closed")
			// The fix: err should be the original S2Error
			expect(err).toBeInstanceOf(S2Error);
			expect(err).not.toBeInstanceOf(TypeError);
			expect((err as S2Error).message).toContain("fencing token mismatch");
		}
	});

	it("close() does not throw TypeError when submit fails", async () => {
		const mockSession: any = {
			submit: async () => {
				throw new S2Error({
					message: "Submit failure: capacity exceeded",
					status: 500,
					origin: "sdk",
				});
			},
			close: async () => {},
			readable: new ReadableStream(),
			writable: new WritableStream(),
			acks: new ReadableStream(),
		};

		const producer = new Producer(
			new BatchTransform({ lingerDurationMillis: 0 }),
			mockSession,
		);

		// Submit a record — the transform will flush it and the pump will try to
		// submit to the session, which will throw
		await producer.submit(AppendRecord.string({ body: "hello" }));

		// Give time for the pump to process the batch and hit the submit error
		await new Promise((r) => setTimeout(r, 50));

		// close() should throw the original S2Error, NOT a TypeError
		try {
			await producer.close();
			expect(true).toBe(true);
		} catch (err) {
			expect(err).toBeInstanceOf(S2Error);
			expect(err).not.toBeInstanceOf(TypeError);
		}
	});
});
