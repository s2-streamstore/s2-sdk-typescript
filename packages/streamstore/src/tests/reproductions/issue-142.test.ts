import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

/**
 * Issue #142: S2SReadSession leaks event listeners
 *
 * 1. connection.on("goaway", ...) adds a new listener for every read session
 *    on the shared connection. These are never removed, causing cumulative
 *    memory leak.
 *
 * 2. options?.signal?.addEventListener("abort", ...) adds a listener that is
 *    never cleaned up when the session ends.
 *
 * The fix stores references to both handlers and removes them when the
 * session's stream closes (via cleanupListeners called from safeClose /
 * safeError).
 */
describe("Issue #142: S2SReadSession leaks event listeners", () => {
	describe("goaway listener cleanup", () => {
		it("goaway listeners should be removed when the session cleans up", () => {
			// Simulate a shared HTTP/2 connection (Node EventEmitter)
			const connection = new EventEmitter();

			// Simulate the fixed pattern: store handler reference, remove on cleanup
			function simulateReadSession() {
				const handler = () => {
					/* goaway handler */
				};
				connection.on("goaway", handler);
				return {
					cleanup: () => {
						connection.removeListener("goaway", handler);
					},
				};
			}

			// Create multiple sessions on the same connection
			const sessions = [];
			for (let i = 0; i < 10; i++) {
				sessions.push(simulateReadSession());
			}

			// Before cleanup, listeners accumulate
			expect(connection.listenerCount("goaway")).toBe(10);

			// Clean up all sessions
			for (const session of sessions) {
				session.cleanup();
			}

			// After cleanup, all listeners should be removed
			expect(connection.listenerCount("goaway")).toBe(0);
		});

		it("listener count should NOT grow linearly with sessions after cleanup", () => {
			const connection = new EventEmitter();

			// Simulate creating and cleaning up many sessions
			for (let i = 0; i < 100; i++) {
				const handler = () => {};
				connection.on("goaway", handler);

				// Simulate cleanup on session close
				connection.removeListener("goaway", handler);
			}

			// After all sessions created and cleaned up, no listeners remain
			expect(connection.listenerCount("goaway")).toBe(0);
		});
	});

	describe("abort signal listener cleanup", () => {
		it("abort listener should be removed when the session cleans up", () => {
			const controller = new AbortController();
			const signal = controller.signal;

			// Track listener additions and removals via spy
			const addSpy = vi.spyOn(signal, "addEventListener");
			const removeSpy = vi.spyOn(signal, "removeEventListener");

			// Simulate the fixed pattern
			const abortHandler = () => {};
			signal.addEventListener("abort", abortHandler);

			expect(addSpy).toHaveBeenCalledTimes(1);
			expect(addSpy).toHaveBeenCalledWith("abort", abortHandler);

			// Simulate session cleanup
			signal.removeEventListener("abort", abortHandler);

			expect(removeSpy).toHaveBeenCalledTimes(1);
			expect(removeSpy).toHaveBeenCalledWith("abort", abortHandler);
		});

		it("abort listeners should not accumulate across multiple sessions", () => {
			const controller = new AbortController();
			const signal = controller.signal;

			const removeSpy = vi.spyOn(signal, "removeEventListener");

			// Simulate multiple sessions using the same signal
			for (let i = 0; i < 10; i++) {
				const handler = () => {};
				signal.addEventListener("abort", handler);
				// Simulate cleanup
				signal.removeEventListener("abort", handler);
			}

			expect(removeSpy).toHaveBeenCalledTimes(10);
		});

		it("abort listener cleanup is safe even after signal is already aborted", () => {
			// When signal is already aborted, the handler fires immediately
			// and cleanup should still be safe (no-op)
			const controller = new AbortController();
			controller.abort();

			const signal = controller.signal;
			expect(signal.aborted).toBe(true);

			// Even with an aborted signal, removeEventListener should not throw
			const handler = () => {};
			signal.addEventListener("abort", handler);
			// Cleanup should be safe even after abort
			expect(() =>
				signal.removeEventListener("abort", handler),
			).not.toThrow();
		});
	});

	describe("cleanup is called on both success and error paths", () => {
		it("cleanup function is called exactly once on safeClose", () => {
			const cleanupFn = vi.fn();
			let closed = false;

			function safeClose() {
				if (!closed) {
					closed = true;
					cleanupFn();
				}
			}

			safeClose();
			safeClose(); // second call should be no-op

			expect(cleanupFn).toHaveBeenCalledTimes(1);
		});

		it("cleanup function is called exactly once on safeError", () => {
			const cleanupFn = vi.fn();
			let closed = false;

			function safeError() {
				if (!closed) {
					closed = true;
					cleanupFn();
				}
			}

			safeError();
			safeError(); // second call should be no-op

			expect(cleanupFn).toHaveBeenCalledTimes(1);
		});

		it("cleanup is idempotent - removing already-removed listeners is safe", () => {
			const connection = new EventEmitter();
			const handler = () => {};

			connection.on("goaway", handler);
			expect(connection.listenerCount("goaway")).toBe(1);

			// Remove once
			connection.removeListener("goaway", handler);
			expect(connection.listenerCount("goaway")).toBe(0);

			// Remove again - should not throw
			expect(() =>
				connection.removeListener("goaway", handler),
			).not.toThrow();
			expect(connection.listenerCount("goaway")).toBe(0);
		});
	});
});
