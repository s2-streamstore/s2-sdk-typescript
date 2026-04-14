import { describe, expect, it } from "vitest";

/**
 * Issue #197: BatchSubmitTicket is a class but is exported via `export type`,
 * so it is erased from the emitted JavaScript. This causes a runtime
 * SyntaxError when consumers try to import it as a value:
 *
 *   import { BatchSubmitTicket } from "@s2-dev/streamstore";
 *   // => SyntaxError: does not provide an export named 'BatchSubmitTicket'
 *
 * The fix moves BatchSubmitTicket from the `export type { ... }` block to a
 * value `export { ... }` so it is present at runtime.
 */

describe("Issue #197: BatchSubmitTicket should be a runtime value export", () => {
	it("BatchSubmitTicket is importable as a value from the package entrypoint", async () => {
		// Dynamic import of the package entrypoint to test what's actually exported at runtime.
		const mod = await import("../../index.js");

		expect(mod.BatchSubmitTicket).toBeDefined();
		expect(typeof mod.BatchSubmitTicket).toBe("function");
	});

	it("BatchSubmitTicket instances have the expected shape", async () => {
		const mod = await import("../../index.js");
		const { BatchSubmitTicket } = mod;

		// Construct a BatchSubmitTicket with a resolved promise to verify runtime behavior.
		const fakeAck = { startSeqNum: 0, endSeqNum: 1, nextSeqNum: 2 };
		const ticket = new BatchSubmitTicket(
			Promise.resolve(fakeAck as any),
			42,
			1,
		);

		expect(ticket).toBeInstanceOf(BatchSubmitTicket);
		expect(ticket.bytes).toBe(42);
		expect(ticket.numRecords).toBe(1);
		expect(await ticket.ack()).toBe(fakeAck);
	});
});
