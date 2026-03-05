import { describe, expect, it } from "vitest";
import { S2Error } from "../../error.js";

describe("Issue #96: Race condition allows session creation after S2Stream.close()", () => {
	it("readSession pattern: close() during transport creation should reject", async () => {
		let closed = false;

		function ensureOpen() {
			if (closed) {
				throw new S2Error({ message: "S2Stream is closed" });
			}
		}

		const mockTransport = {
			makeReadSession: async () => ({ records: [] }),
			close: async () => {},
		};

		let resolveTransport!: (t: typeof mockTransport) => void;
		const transportPromise = new Promise<typeof mockTransport>((resolve) => {
			resolveTransport = resolve;
		});

		async function getTransport() {
			ensureOpen();
			return transportPromise;
		}

		async function readSessionFixed() {
			ensureOpen();
			const transport = await getTransport();
			ensureOpen(); // Re-check after async gap (the fix)
			return transport.makeReadSession();
		}

		const sessionPromise = readSessionFixed();
		closed = true;
		resolveTransport(mockTransport);

		await expect(sessionPromise).rejects.toThrow("S2Stream is closed");
	});

	it("appendSession pattern: close() during transport creation should reject", async () => {
		let closed = false;

		function ensureOpen() {
			if (closed) {
				throw new S2Error({ message: "S2Stream is closed" });
			}
		}

		const mockTransport = {
			makeAppendSession: async () => ({ submit: async () => {} }),
			close: async () => {},
		};

		let resolveTransport!: (t: typeof mockTransport) => void;
		const transportPromise = new Promise<typeof mockTransport>((resolve) => {
			resolveTransport = resolve;
		});

		async function getTransport() {
			ensureOpen();
			return transportPromise;
		}

		async function appendSessionFixed() {
			ensureOpen();
			const transport = await getTransport();
			ensureOpen(); // Re-check after async gap (the fix)
			return transport.makeAppendSession();
		}

		const sessionPromise = appendSessionFixed();
		closed = true;
		resolveTransport(mockTransport);

		await expect(sessionPromise).rejects.toThrow("S2Stream is closed");
	});

	it("without the fix: session would be created on closed transport", async () => {
		let closed = false;

		function ensureOpen() {
			if (closed) {
				throw new S2Error({ message: "S2Stream is closed" });
			}
		}

		let sessionCreated = false;
		const mockTransport = {
			makeReadSession: async () => {
				sessionCreated = true;
				return { records: [] };
			},
			close: async () => {},
		};

		let resolveTransport!: (t: typeof mockTransport) => void;
		const transportPromise = new Promise<typeof mockTransport>((resolve) => {
			resolveTransport = resolve;
		});

		async function getTransport() {
			ensureOpen();
			return transportPromise;
		}

		async function readSessionBuggy() {
			ensureOpen();
			const transport = await getTransport();
			return transport.makeReadSession();
		}

		const sessionPromise = readSessionBuggy();
		closed = true;
		resolveTransport(mockTransport);

		await sessionPromise;
		expect(sessionCreated).toBe(true);
	});
});
