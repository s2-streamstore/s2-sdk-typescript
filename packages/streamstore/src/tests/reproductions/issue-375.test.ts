import { beforeEach, describe, expect, it, vi } from "vitest";

var createSessionTransportImpl: typeof import("../../lib/stream/factory.js")["createSessionTransport"];

vi.mock("../../lib/stream/factory.js", async (importOriginal) => {
	const mod =
		(await importOriginal()) as typeof import("../../lib/stream/factory.js");
	createSessionTransportImpl = mod.createSessionTransport;
	return {
		...mod,
		createSessionTransport: vi.fn(mod.createSessionTransport),
	};
});

import { createSessionTransport } from "../../lib/stream/factory.js";
import type { SessionTransport } from "../../lib/stream/types.js";
import { S2Stream } from "../../stream.js";

/**
 * Bug introduced in 12f0903 (PR #157): `S2Stream` caches a `_transportPromise`
 * that can reject — `getTransport()`'s `.catch` re-throws. `close()` awaited
 * that promise inside a `try/finally` with no `catch`, so when `close()` ran
 * while transport creation was still pending and that creation rejected,
 * `close()` re-threw the same error the session-open call was already
 * surfacing — a cleanup operation surfacing a construction error and, in
 * explicit `try/finally`, masking the body error.
 *
 * The fix treats a rejected `_transportPromise` as "nothing to close", so
 * `close()` completes without surfacing transport-construction errors. The
 * factory mock is a passthrough (it calls the real `createSessionTransport`
 * by default), so the "invalid baseUrl" cases below exercise the real
 * `S2STransport` constructor's `new URL(...)` throw path, not a stub.
 */
describe("S2Stream.close() during failing/pending transport creation", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(createSessionTransport).mockImplementation(
			createSessionTransportImpl,
		);
	});

	describe("via real createSessionTransport (invalid baseUrl)", () => {
		it("close() resolves when readSession() kicks off transport creation that rejects concurrently", async () => {
			const stream = new S2Stream(
				"events",
				{} as any,
				{
					baseUrl: "not-a-valid-url",
					accessToken: {} as any,
				} as any,
			);

			const readPromise = stream.readSession().catch((e) => e);
			const closePromise = stream.close().catch((e) => e);

			const [readResult, closeResult] = await Promise.all([
				readPromise,
				closePromise,
			]);

			expect(readResult).toBeInstanceOf(Error);
			expect((readResult as Error).message).toMatch(/Invalid URL/i);
			expect(closeResult).toBeUndefined();
		});

		it("close() resolves when appendSession() kicks off transport creation that rejects concurrently", async () => {
			const stream = new S2Stream(
				"events",
				{} as any,
				{
					baseUrl: "not-a-valid-url",
					accessToken: {} as any,
				} as any,
			);

			const appendPromise = stream.appendSession().catch((e) => e);
			const closePromise = stream.close().catch((e) => e);

			const [appendResult, closeResult] = await Promise.all([
				appendPromise,
				closePromise,
			]);

			expect(appendResult).toBeInstanceOf(Error);
			expect((appendResult as Error).message).toMatch(/Invalid URL/i);
			expect(closeResult).toBeUndefined();
		});

		it("subsequent close() after a failed close resolves to undefined (idempotent)", async () => {
			const stream = new S2Stream(
				"events",
				{} as any,
				{
					baseUrl: "not-a-valid-url",
					accessToken: {} as any,
				} as any,
			);
			stream.readSession().catch((e) => e);

			await expect(stream.close()).resolves.toBeUndefined();
			await expect(stream.close()).resolves.toBeUndefined();

			// Post-close state is consistent: further session opens report the
			// stream as closed rather than attempting transport creation.
			await expect(stream.readSession()).rejects.toThrow("S2Stream is closed");
			await expect(stream.appendSession()).rejects.toThrow(
				"S2Stream is closed",
			);
		});

		it("await using does not mask a body error with the transport-creation error", async () => {
			let caught: unknown;
			try {
				await using stream = new S2Stream(
					"events",
					{} as any,
					{
						baseUrl: "not-a-valid-url",
						accessToken: {} as any,
					} as any,
				);
				stream.readSession().catch((e) => e);
				throw new Error("body failure");
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(Error);
			expect((caught as Error).message).toBe("body failure");
		});
	});

	describe("via mocked createSessionTransport (happy path)", () => {
		function makeMockTransport() {
			const closeSpy = vi.fn().mockResolvedValue(undefined);
			const transport = {
				makeAppendSession: vi.fn(),
				makeReadSession: vi.fn(),
				close: closeSpy,
			} as unknown as SessionTransport;
			return { transport, closeSpy };
		}

		it("close() closes the transport when transport creation resolves (happy-path regression)", async () => {
			const { transport, closeSpy } = makeMockTransport();
			vi.mocked(createSessionTransport).mockImplementation(
				async () => transport,
			);

			const stream = new S2Stream("events", {} as any, {} as any);
			await stream.readSession();
			await stream.close();

			expect(closeSpy).toHaveBeenCalledTimes(1);
		});

		it("close() latches a pending transport and closes it once it resolves", async () => {
			const { transport, closeSpy } = makeMockTransport();
			let resolveTransport!: (t: SessionTransport) => void;
			vi.mocked(createSessionTransport).mockImplementation(
				() =>
					new Promise<SessionTransport>((resolve) => {
						resolveTransport = resolve;
					}),
			);

			const stream = new S2Stream("events", {} as any, {} as any);
			const readPromise = stream.readSession().catch((e) => e);
			const closePromise = stream.close();

			resolveTransport(transport);

			await expect(closePromise).resolves.toBeUndefined();
			const readResult = await readPromise;
			expect(readResult).toBeInstanceOf(Error);
			expect((readResult as Error).message).toBe("S2Stream is closed");
			expect(closeSpy).toHaveBeenCalledTimes(1);
		});
	});
});
