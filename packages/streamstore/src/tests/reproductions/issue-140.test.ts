import { describe, expect, it, vi } from "vitest";

describe("Issue #140: S2Stream.getTransport() race condition", () => {
	it("concurrent getTransport calls should share a single transport", async () => {
		// We test the pattern directly since S2Stream.getTransport is private.
		// This verifies that caching a promise (not its result) prevents double-creation.

		let createCount = 0;

		// Simulate the buggy pattern: check-then-await
		async function buggyGetTransport() {
			// Multiple callers see _transport as undefined and all create
			const transport = await createTransport();
			return transport;
		}

		// Simulate the fixed pattern: cache the promise
		let transportPromise: Promise<string> | undefined;
		function fixedGetTransport() {
			if (!transportPromise) {
				transportPromise = createTransport();
			}
			return transportPromise;
		}

		async function createTransport(): Promise<string> {
			createCount++;
			// Simulate async transport creation
			await new Promise((r) => setTimeout(r, 10));
			return "transport-" + createCount;
		}

		// Test the fixed pattern: concurrent calls share one promise
		createCount = 0;
		const [t1, t2, t3] = await Promise.all([
			fixedGetTransport(),
			fixedGetTransport(),
			fixedGetTransport(),
		]);

		expect(createCount).toBe(1);
		expect(t1).toBe(t2);
		expect(t2).toBe(t3);
	});

	it("close should await and clean up the transport promise", async () => {
		let closed = false;
		const mockTransport = {
			close: async () => {
				closed = true;
			},
		};

		let transportPromise: Promise<typeof mockTransport> | undefined =
			Promise.resolve(mockTransport);

		// Simulate close() awaiting the promise
		if (transportPromise) {
			const transport = await transportPromise;
			await transport.close();
			transportPromise = undefined;
		}

		expect(closed).toBe(true);
		expect(transportPromise).toBeUndefined();
	});
});
