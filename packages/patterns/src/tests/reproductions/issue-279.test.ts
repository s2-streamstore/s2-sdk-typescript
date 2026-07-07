import { S2Error } from "@s2-dev/streamstore";
import { describe, expect, it } from "vitest";
import { SerializingAppendSession } from "../../patterns/serialization.js";

/**
 * Issue #279: a serializer producing zero bytes (e.g. JSON.stringify(undefined))
 * made submit() crash with an opaque TypeError (`durable[0]` undefined), while
 * write() threw a clear S2Error from AppendInput.create(). The fix rejects
 * empty serializations in toRecords() so both paths throw the same S2Error.
 */

class FakeAppendSession {
	submitCalls = 0;

	async submit(): Promise<any> {
		this.submitCalls += 1;
		const ack = {
			start: { seqNum: 0, timestamp: 0 },
			end: { seqNum: 1, timestamp: 0 },
			tail: { seqNum: 1, timestamp: 0 },
		};
		return { ack: async () => ack, bytes: 0, numRecords: 1 };
	}

	async close(): Promise<void> {}
}

const jsonSerializer = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value));

describe("Issue #279: empty serialization throws S2Error instead of TypeError", () => {
	it("submit() rejects with S2Error and submits nothing", async () => {
		const fakeSession = new FakeAppendSession();
		const session = new SerializingAppendSession<unknown>(
			fakeSession as any,
			jsonSerializer,
		);

		// JSON.stringify(undefined) === undefined -> encode() yields 0 bytes.
		await expect(session.submit(undefined)).rejects.toThrow(S2Error);
		expect(fakeSession.submitCalls).toBe(0);

		// Session remains usable for valid messages.
		await expect(session.submit({ ok: true })).resolves.toEqual({
			start: 0,
			end: 1,
		});
	});

	it("write() rejects with the same S2Error", async () => {
		const session = new SerializingAppendSession<unknown>(
			new FakeAppendSession() as any,
			jsonSerializer,
		);
		const writer = session.getWriter();

		const err = await writer.write(undefined).catch((e) => e);
		expect(err).toBeInstanceOf(S2Error);
		expect(err.message).toContain("Serialized message is empty");
	});
});
