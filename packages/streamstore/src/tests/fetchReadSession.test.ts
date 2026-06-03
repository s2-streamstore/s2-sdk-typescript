import { describe, expect, it } from "vitest";
import { FetchReadSession } from "../lib/stream/transport/fetch/index.js";

describe("FetchReadSession", () => {
	it("converts raw browser body stream errors into transport error results", async () => {
		const body = new ReadableStream<Uint8Array>({
			pull() {
				throw new TypeError("network error");
			},
		});
		const session = FetchReadSession._createForTesting(body, "string");
		const reader = session.getReader();

		const first = await reader.read();
		expect(first.done).toBe(false);
		expect(first.value).toBeDefined();
		const result = first.value!;
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.status).toBe(502);
			expect(result.error.code).toBe("NETWORK_ERROR");
		}

		await expect(reader.read()).resolves.toEqual({
			done: true,
			value: undefined,
		});
	});
});
