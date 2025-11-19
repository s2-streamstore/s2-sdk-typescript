import { describe, expect, it } from "vitest";
import { S2Error, withS2Error } from "../error.js";

describe("withS2Error response parsing", () => {
	it("returns result when response has no error", async () => {
		const value = await withS2Error(async () => ({
			data: { ok: 1 },
			error: undefined,
			response: { status: 200, statusText: "OK" },
		}));

		expect(value).toMatchObject({ data: { ok: 1 }, response: { status: 200 } });
	});

	it("throws S2Error with message/code/status when response.error has message", async () => {
		const run = () =>
			withS2Error(async () => ({
				data: undefined,
				error: { message: "Bad things", code: "BAD_THING" },
				response: { status: 400, statusText: "Bad Request" },
			}));

		await expect(run()).rejects.toMatchObject({
			name: "S2Error",
			message: "Bad things",
			code: "BAD_THING",
			status: 400,
		});
	});

	it("falls back to HTTP statusText when error lacks message", async () => {
		const run = () =>
			withS2Error(async () => ({
				data: undefined,
				error: { something: "else" },
				response: { status: 502, statusText: "Bad Gateway" },
			}));

		await expect(run()).rejects.toMatchObject({
			name: "S2Error",
			message: "Bad Gateway",
			status: 502,
		});
	});

	it("wraps thrown errors as S2Error via s2Error()", async () => {
		const run = () =>
			withS2Error(async () => {
				throw new Error("boom");
			});

		const err = await run().catch((e) => e as S2Error);
		expect(err).toBeInstanceOf(S2Error);
		expect(err.message).toBe("boom");
		// Generic thrown errors get status 0 in s2Error()
		expect(err.status).toBe(0);
	});
});
