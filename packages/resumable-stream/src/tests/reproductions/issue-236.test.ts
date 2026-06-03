import type { S2 } from "@s2-dev/streamstore";
import { AppendRecord, FencingTokenMismatchError } from "@s2-dev/streamstore";
import { describe, expect, it } from "vitest";
import { persistToS2 } from "../../protocol.js";

/**
 * Issue #236: a takeover mid-persist surfaced as
 * AggregateError([S2Error, FencingTokenMismatchError]) because submit()
 * wrapped the pump error, failing the adapter's takeover check. After the
 * fix, every phase surfaces the original error and the failure stays
 * classifiable.
 */

/** A fake S2 whose append sessions always reject with the given error. */
function makeFencedS2(error: FencingTokenMismatchError): S2 {
	const session = {
		readable: new ReadableStream(),
		writable: new WritableStream(),
		submit: () => Promise.reject(error),
		close: () => Promise.resolve(),
		acks: () => new ReadableStream(),
		lastAckedPosition: () => undefined,
		failureCause: () => undefined,
		[Symbol.asyncDispose]: () => Promise.resolve(),
	};
	const handle = {
		appendSession: () => Promise.resolve(session),
		close: () => Promise.resolve(),
	};
	return {
		basin: () => ({ stream: () => handle }),
	} as unknown as S2;
}

async function* source(values: string[]): AsyncIterable<string> {
	for (const value of values) {
		yield value;
		// Give the pump a chance to observe the rejection between submits.
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("Issue #236: persist failure during takeover stays classifiable", () => {
	it("rejects with the original FencingTokenMismatchError, not a mixed aggregate", async () => {
		const fencing = new FencingTokenMismatchError({
			message: "fencing token mismatch",
			expectedFencingToken: "other-writer",
		});

		const failure = await persistToS2({
			s2: makeFencedS2(fencing),
			basin: "test-basin",
			stream: "test-stream",
			source: source(["a", "b", "c"]),
			fencingToken: "session-original",
			batchSize: 1,
			lingerDuration: 0,
			toRecord: (value) => AppendRecord.string({ body: value }),
			finalRecords: () => [AppendRecord.fence("end-test")],
		}).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(failure).toBeDefined();
		// The adapter's takeover check.
		const isTakeover =
			failure instanceof FencingTokenMismatchError ||
			(failure instanceof AggregateError &&
				failure.errors.length > 0 &&
				failure.errors.every(
					(error) => error instanceof FencingTokenMismatchError,
				));
		expect(isTakeover).toBe(true);
	});
});
