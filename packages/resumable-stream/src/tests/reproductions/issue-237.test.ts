import {
	FencingTokenMismatchError,
	RangeNotSatisfiableError,
} from "@s2-dev/streamstore";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Issue #237: `createResumableStream` called `makeStream().tee()` before
 * validation, leaking both teed branches on every early return. After the
 * fix, the caller's stream is only created once validation succeeds.
 */

const mock = vi.hoisted(() => ({
	handle: {} as Record<string, unknown>,
}));

vi.mock("@s2-dev/streamstore", async () => {
	const actual = await vi.importActual<typeof import("@s2-dev/streamstore")>(
		"@s2-dev/streamstore",
	);
	class MockS2 {
		basin() {
			return { stream: () => mock.handle };
		}
	}
	return { ...actual, S2: MockS2 };
});

/** A ReadBatch whose single record is a terminal fence ("stream done"). */
const doneBatch = {
	records: [
		{
			headers: [["", "fence"]],
			body: "end-abc12",
		},
	],
};

function makeCtx(waitUntilPromises: Promise<unknown>[] = []) {
	return import("../../index.js").then(({ createResumableStreamContext }) =>
		createResumableStreamContext({
			waitUntil: (p) => {
				waitUntilPromises.push(p.catch(() => {}));
			},
		}),
	);
}

describe("Issue #237: no stream is created when validation fails", () => {
	const savedEnv: Record<string, string | undefined> = {};

	beforeAll(() => {
		for (const key of [
			"S2_ACCESS_TOKEN",
			"S2_BASIN",
			"S2_ACCOUNT_ENDPOINT",
			"S2_BASIN_ENDPOINT",
		]) {
			savedEnv[key] = process.env[key];
		}

		process.env.S2_ACCESS_TOKEN = "ignored";
		process.env.S2_BASIN = "test-basin";
		process.env.S2_ACCOUNT_ENDPOINT = "http://localhost:80";
		process.env.S2_BASIN_ENDPOINT = "http://localhost:80";
	});

	afterAll(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		vi.restoreAllMocks();
	});

	it("does not invoke makeStream when the stream is already done", async () => {
		mock.handle = {
			read: () => Promise.resolve(doneBatch),
		};
		const makeStream = vi.fn(() => new ReadableStream<string>());
		const ctx = await makeCtx();

		const result = await ctx.resumableStream("done-stream", makeStream);

		expect(result).toBeNull();
		expect(makeStream).not.toHaveBeenCalled();
	}, 10_000);

	it("does not invoke makeStream when the status check fails", async () => {
		mock.handle = {
			read: () => Promise.reject(new Error("boom")),
		};
		const makeStream = vi.fn(() => new ReadableStream<string>());
		const ctx = await makeCtx();

		const result = await ctx.resumableStream("broken-stream", makeStream);

		expect(result).toBeNull();
		expect(makeStream).not.toHaveBeenCalled();
	}, 10_000);

	it("does not invoke makeStream when another writer holds the fence", async () => {
		mock.handle = {
			read: () => Promise.reject(new RangeNotSatisfiableError()),
			append: () =>
				Promise.reject(
					new FencingTokenMismatchError({
						message: "fencing token mismatch",
						expectedFencingToken: "other-writer",
					}),
				),
			// resumeStream path; reject so it resolves to null.
			readSession: () => Promise.reject(new Error("Not Found (404)")),
		};
		const makeStream = vi.fn(() => new ReadableStream<string>());
		const ctx = await makeCtx();

		const result = await ctx.resumableStream("contested-stream", makeStream);

		expect(result).toBeNull();
		expect(makeStream).not.toHaveBeenCalled();
	}, 10_000);

	it("does not invoke makeStream when the fence append fails", async () => {
		mock.handle = {
			read: () => Promise.reject(new RangeNotSatisfiableError()),
			append: () => Promise.reject(new Error("append failed")),
		};
		const makeStream = vi.fn(() => new ReadableStream<string>());
		const ctx = await makeCtx();

		const result = await ctx.resumableStream("unappendable-stream", makeStream);

		expect(result).toBeNull();
		expect(makeStream).not.toHaveBeenCalled();
	}, 10_000);

	it("creates the stream once and passes values through on success", async () => {
		mock.handle = {
			read: () => Promise.reject(new RangeNotSatisfiableError()),
			append: () =>
				Promise.resolve({
					start: { seqNum: 0, timestamp: new Date(0) },
					end: { seqNum: 1, timestamp: new Date(0) },
					tail: { seqNum: 1, timestamp: new Date(0) },
				}),
			// Fail persistence; the background persist swallows the error.
			appendSession: () => Promise.reject(new Error("no session in test")),
			close: () => Promise.resolve(),
		};
		const makeStream = vi.fn(
			() =>
				new ReadableStream<string>({
					start(controller) {
						controller.enqueue("x");
						controller.enqueue("y");
						controller.close();
					},
				}),
		);
		const waitUntilPromises: Promise<unknown>[] = [];
		const ctx = await makeCtx(waitUntilPromises);

		const result = await ctx.resumableStream("fresh-stream", makeStream);

		expect(makeStream).toHaveBeenCalledTimes(1);
		expect(result).not.toBeNull();

		const got: string[] = [];
		const reader = result!.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			got.push(value);
		}
		expect(got).toEqual(["x", "y"]);

		await Promise.all(waitUntilPromises);
	}, 10_000);
});
