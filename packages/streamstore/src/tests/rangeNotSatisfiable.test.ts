import { describe, expect, it } from "vitest";
import { RangeNotSatisfiableError } from "../error.js";
import { createClient, createConfig } from "../generated/client/index.js";
import { fromAPIStreamPosition } from "../internal/mappers.js";
import { FetchReadSession } from "../lib/stream/transport/fetch/index.js";

/**
 * Issue #257 (camelCase polish): RangeNotSatisfiableError.tail exposed the
 * wire-format seq_num. It now uses the public StreamPosition shape.
 */
describe("RangeNotSatisfiableError.tail", () => {
	it("exposes the tail as a camelCase StreamPosition", () => {
		const err = new RangeNotSatisfiableError({
			tail: { seqNum: 42, timestamp: new Date(1000) },
		});

		expect(err.tail).toEqual({ seqNum: 42, timestamp: new Date(1000) });
		expect(err.tail).not.toHaveProperty("seq_num");
		expect(err.message).toContain("seqNum=42");
		expect(err.status).toBe(416);
	});

	it("maps the wire payload used by transports to the public shape", () => {
		const tail = fromAPIStreamPosition({ seq_num: 7, timestamp: 456 });

		expect(tail).toEqual({ seqNum: 7, timestamp: new Date(456) });
	});

	it("omits the tail when the payload has none", () => {
		const err = new RangeNotSatisfiableError();

		expect(err.tail).toBeUndefined();
		expect(err.message).toBe(
			"Range not satisfiable: starting point is out of range.",
		);
	});

	it("maps fetch readSession 416 payload tails to the public shape", async () => {
		const client = createClient(
			createConfig({
				auth: "ignored",
				baseUrl: "http://example.test/v1",
				fetch: (async () =>
					new Response(
						JSON.stringify({
							code: "RANGE_NOT_SATISFIABLE",
							tail: { seq_num: 3, timestamp: 1234 },
						}),
						{
							status: 416,
							statusText: "Range Not Satisfiable",
							headers: { "content-type": "application/json" },
						},
					)) as unknown as typeof fetch,
			}),
		);

		await expect(
			FetchReadSession.create(client, "test-stream", { seq_num: 999_999 }),
		).rejects.toMatchObject({
			name: "RangeNotSatisfiableError",
			status: 416,
			tail: { seqNum: 3, timestamp: new Date(1234) },
		});
	});
});
