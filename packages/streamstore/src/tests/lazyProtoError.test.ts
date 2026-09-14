import { describe, expect, it, vi } from "vitest";
import { S2Error, s2Error } from "../error.js";
import type { Client } from "../generated/client/index.js";
import { isRetryable } from "../lib/retry.js";
import {
	loadProtoCodec,
	streamAppend,
} from "../lib/stream/transport/fetch/shared.js";
import type { AppendInput } from "../types.js";

const append = vi.hoisted(() => vi.fn());

vi.mock("../generated/index.js", () => ({
	append,
	read: vi.fn(),
}));

// A `vi.mock` factory `throw` is re-wrapped by vitest into a
// "[vitest] There was an error when mocking a module..." error, so the real
// Safari "Load failed" message never reaches `loadProtoCodec` through this
// path. The direct `loadProtoCodec` test below uses an injectable loader to
// exercise the real Safari message — and act as the regression guard.
vi.mock("../lib/stream/transport/proto.js", () => {
	throw new TypeError("Failed to fetch");
});

describe("lazy protobuf codec errors", () => {
	it("streamAppend surfaces a failed proto import as non-retryable PROTO_CODEC_LOAD_FAILED and skips the HTTP append", async () => {
		const input: AppendInput = {
			records: [{ body: new Uint8Array([1]), meteredBytes: 9 }],
			meteredBytes: 9,
		};

		const error = await streamAppend("test-stream", {} as Client, input).catch(
			(caught) => caught,
		);

		expect(error).toBeInstanceOf(S2Error);
		expect(error.code).toBe("PROTO_CODEC_LOAD_FAILED");
		expect(error.status).toBe(0);
		expect(error.origin).toBe("sdk");
		expect(isRetryable(error)).toBe(false);
		expect(append).not.toHaveBeenCalled();
	});

	// Safari reuses "Load failed" for both `fetch()` and dynamic `import()`
	// network failures, so routing the load error through `s2Error` would
	// classify it as a retryable 502. The injectable loader lets the real
	// Safari message reach `loadProtoCodec` without vitest re-wrapping it;
	// reverting `loadProtoCodec` to `throw s2Error(error)` makes this test fail.
	it("wraps a Safari 'Load failed' import failure as a non-retryable PROTO_CODEC_LOAD_FAILED that preserves the underlying message", async () => {
		const error = await loadProtoCodec(() =>
			Promise.reject(new TypeError("Load failed")),
		).catch((caught) => caught);

		expect(error).toBeInstanceOf(S2Error);
		expect(error.code).toBe("PROTO_CODEC_LOAD_FAILED");
		expect(error.status).toBe(0);
		expect(error.origin).toBe("sdk");
		expect(isRetryable(error)).toBe(false);
		expect(error.message).toBe("Failed to load protobuf codec: Load failed");
	});

	// Documents why `loadProtoCodec` does NOT route through `s2Error`: Safari's
	// "Load failed" is the same message Safari uses for `fetch()` failures, so
	// `s2Error` must keep classifying it as a retryable 502 for the real fetch
	// retry path. `loadProtoCodec` bypasses `s2Error` to avoid that collision.
	it("s2Error still classifies Safari 'Load failed' as a retryable 502 (the misclassification loadProtoCodec must avoid)", () => {
		const fetchError = s2Error(new TypeError("Load failed"));
		expect(fetchError.status).toBe(502);
		expect(fetchError.code).toBe("NETWORK_ERROR");
		expect(fetchError.origin).toBe("sdk");
		expect(isRetryable(fetchError)).toBe(true);
	});
});
