import { describe, expect, it, vi } from "vitest";
import { S2Error } from "../error.js";
import { CaughtUpTracker } from "../lib/stream/caught-up-tracker.js";
import type { StreamPosition } from "../types.js";

const tailAt = (seqNum: number): StreamPosition => ({
	seqNum,
	timestamp: new Date(seqNum * 1000),
});

describe("CaughtUpTracker", () => {
	it("settles multiple waiters only after a caught-up boundary is delivered", async () => {
		const tracker = new CaughtUpTracker();
		const first = tracker.caughtUp();
		const second = tracker.caughtUp();
		const settled = vi.fn();
		void first.then(settled, settled);
		void second.then(settled, settled);

		const boundary = tracker.observeBatch({
			recordCount: 2,
			lastSeqNum: 4,
			tail: tailAt(5),
		});

		expect(boundary?.tail).toEqual(tailAt(5));
		expect(tracker.isCaughtUp()).toBe(false);
		expect(settled).not.toHaveBeenCalled();

		boundary?.markDelivered();

		await expect(first).resolves.toEqual(tailAt(5));
		await expect(second).resolves.toEqual(tailAt(5));
		expect(tracker.isCaughtUp()).toBe(true);
		await expect(tracker.caughtUp()).resolves.toEqual(tailAt(5));
	});

	it("represents an empty heartbeat as an immediately drainable boundary", async () => {
		const tracker = new CaughtUpTracker();
		const caughtUp = tracker.caughtUp();

		const boundary = tracker.observeBatch({
			recordCount: 0,
			tail: tailAt(12),
		});

		expect(boundary).toBeDefined();
		expect(tracker.isCaughtUp()).toBe(false);

		boundary?.markDelivered();

		await expect(caughtUp).resolves.toEqual(tailAt(12));
		expect(tracker.isCaughtUp()).toBe(true);
	});

	it("uses the unfiltered final sequence number to establish a boundary", async () => {
		const tracker = new CaughtUpTracker();
		const caughtUp = tracker.caughtUp();

		// The second raw record is a filtered command record. The delivery layer
		// retains this boundary with the one remaining visible record.
		const boundary = tracker.observeBatch({
			recordCount: 2,
			lastSeqNum: 1,
			tail: tailAt(2),
		});

		expect(boundary).toBeDefined();
		expect(tracker.isCaughtUp()).toBe(false);

		// Simulates draining the remaining visible record.
		boundary?.markDelivered();
		await expect(caughtUp).resolves.toEqual(tailAt(2));
	});

	it("marks itself behind when a batch does not establish a boundary", async () => {
		const tracker = new CaughtUpTracker();
		tracker.observeBatch({ recordCount: 0, tail: tailAt(3) })?.markDelivered();
		expect(tracker.isCaughtUp()).toBe(true);

		expect(
			tracker.observeBatch({
				recordCount: 1,
				lastSeqNum: 3,
				tail: tailAt(5),
			}),
		).toBeUndefined();
		expect(tracker.isCaughtUp()).toBe(false);

		const pending = tracker.caughtUp();
		const settled = vi.fn();
		void pending.then(settled, settled);
		await Promise.resolve();
		expect(settled).not.toHaveBeenCalled();

		tracker.observeBatch({ recordCount: 0, tail: tailAt(5) })?.markDelivered();
		await expect(pending).resolves.toEqual(tailAt(5));
	});

	it("allows only the newest observed boundary to transition the state", async () => {
		const tracker = new CaughtUpTracker();
		const caughtUp = tracker.caughtUp();
		const settled = vi.fn();
		void caughtUp.then(settled, settled);

		const older = tracker.observeBatch({
			recordCount: 1,
			lastSeqNum: 0,
			tail: tailAt(1),
		});
		const newer = tracker.observeBatch({
			recordCount: 1,
			lastSeqNum: 1,
			tail: tailAt(2),
		});

		older?.markDelivered();
		await Promise.resolve();
		expect(tracker.isCaughtUp()).toBe(false);
		expect(settled).not.toHaveBeenCalled();

		newer?.markDelivered();
		await expect(caughtUp).resolves.toEqual(tailAt(2));

		// Delivery handles are idempotent.
		newer?.markDelivered();
		expect(tracker.isCaughtUp()).toBe(true);
	});

	it("keeps waiters pending across reconnect and ignores stale boundaries", async () => {
		const tracker = new CaughtUpTracker();
		const caughtUp = tracker.caughtUp();
		const settled = vi.fn();
		void caughtUp.then(settled, settled);
		const stale = tracker.observeBatch({
			recordCount: 0,
			tail: tailAt(8),
		});

		tracker.reconnect();
		stale?.markDelivered();
		await Promise.resolve();
		expect(tracker.isCaughtUp()).toBe(false);
		expect(settled).not.toHaveBeenCalled();

		tracker.observeBatch({ recordCount: 0, tail: tailAt(9) })?.markDelivered();
		await expect(caughtUp).resolves.toEqual(tailAt(9));
	});

	it("rejects pending waiters on a clean end and invalidates boundaries", async () => {
		const tracker = new CaughtUpTracker();
		const caughtUp = tracker.caughtUp();
		const stale = tracker.observeBatch({
			recordCount: 0,
			tail: tailAt(4),
		});

		tracker.end();
		stale?.markDelivered();

		await expect(caughtUp).rejects.toMatchObject({ code: "SESSION_CLOSED" });
		await expect(tracker.caughtUp()).rejects.toMatchObject({
			code: "SESSION_CLOSED",
		});
		expect(tracker.isCaughtUp()).toBe(false);
		expect(
			tracker.observeBatch({ recordCount: 0, tail: tailAt(5) }),
		).toBeUndefined();
	});

	it("preserves an already caught-up state on a clean end", async () => {
		const tracker = new CaughtUpTracker();
		tracker.observeBatch({ recordCount: 0, tail: tailAt(6) })?.markDelivered();

		tracker.end();

		expect(tracker.isCaughtUp()).toBe(true);
		await expect(tracker.caughtUp()).resolves.toEqual(tailAt(6));
	});

	it("clears caught-up state and rejects waiters with a terminal error", async () => {
		const tracker = new CaughtUpTracker();
		tracker.observeBatch({ recordCount: 0, tail: tailAt(6) })?.markDelivered();
		tracker.observeBatch({ recordCount: 1, lastSeqNum: 6 });
		const caughtUp = tracker.caughtUp();
		const error = new S2Error({ message: "read failed", status: 503 });

		tracker.end(error);

		await expect(caughtUp).rejects.toBe(error);
		await expect(tracker.caughtUp()).rejects.toBe(error);
		expect(tracker.isCaughtUp()).toBe(false);
	});
});
