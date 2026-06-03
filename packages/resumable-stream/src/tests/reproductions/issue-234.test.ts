import { describe, expect, it, vi } from "vitest";
import { pipeSseFrames } from "../../client-utils.js";

/**
 * Issue #234: when the consumer stopped iterating without an abort signal,
 * `pipeSseFrames` only released the reader lock, leaving the fetch body (and
 * the connection) open. The fix cancels the reader on early termination.
 */

function sseFrame(id: number, data: string): string {
	return `id: ${id}\ndata: ${data}\n\n`;
}

/** An endless SSE body that records whether it was canceled. */
function endlessBody(): {
	body: ReadableStream<Uint8Array>;
	wasCancelled: () => boolean;
} {
	const encoder = new TextEncoder();
	let cancelled = false;
	let nextId = 1;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(encoder.encode(sseFrame(nextId, `chunk-${nextId}`)));
			nextId += 1;
		},
		cancel() {
			cancelled = true;
		},
	});
	return { body, wasCancelled: () => cancelled };
}

describe("Issue #234: pipeSseFrames cancels the body on early termination", () => {
	it("cancels the source body when the consumer breaks without an abort signal", async () => {
		const { body, wasCancelled } = endlessBody();

		for await (const frame of pipeSseFrames(body)) {
			expect(frame.data).toBe("chunk-1");
			break;
		}

		// Cancellation propagates through the pipeThrough chain asynchronously.
		await vi.waitFor(() => {
			expect(wasCancelled()).toBe(true);
		});
	});

	it("cancels the source body when the consumer throws mid-iteration", async () => {
		const { body, wasCancelled } = endlessBody();

		await expect(
			(async () => {
				for await (const _frame of pipeSseFrames(body)) {
					throw new Error("consumer failure");
				}
			})(),
		).rejects.toThrow("consumer failure");

		await vi.waitFor(() => {
			expect(wasCancelled()).toBe(true);
		});
	});

	it("still cancels via the abort signal", async () => {
		const { body, wasCancelled } = endlessBody();
		const controller = new AbortController();

		for await (const _frame of pipeSseFrames(body, controller.signal)) {
			controller.abort();
		}

		await vi.waitFor(() => {
			expect(wasCancelled()).toBe(true);
		});
	});

	it("consumes a finite body to completion without error", async () => {
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseFrame(1, "a")));
				controller.enqueue(encoder.encode(sseFrame(2, "b")));
				controller.close();
			},
		});

		const got: string[] = [];
		for await (const frame of pipeSseFrames(body)) {
			got.push(frame.data);
		}
		expect(got).toEqual(["a", "b"]);
	});
});
