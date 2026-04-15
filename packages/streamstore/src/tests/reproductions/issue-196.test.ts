import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../generated/index.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../generated/index.js")
	>("../../generated/index.js");
	return {
		...actual,
		reconfigureBasin: vi.fn(),
		reconfigureStream: vi.fn(),
	};
});

import * as Generated from "../../generated/index.js";
import { S2Basins } from "../../basins.js";
import { S2Streams } from "../../streams.js";

/**
 * Issue #196: reconfigure methods send path params (basin/stream) in the request body.
 *
 * These tests hit the actual `reconfigure()` methods and inspect the generated
 * client calls to ensure the identifiers stay in `path`, not `body`.
 */

describe("Issue #196: reconfigure body must not include path parameters", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(Generated.reconfigureBasin).mockResolvedValue({
			data: {},
			response: { status: 200 },
		} as any);
		vi.mocked(Generated.reconfigureStream).mockResolvedValue({
			data: {},
			response: { status: 200 },
		} as any);
	});

	it("actual streams.reconfigure sends the stream name only in path", async () => {
		const streams = new S2Streams({} as any);

		await streams.reconfigure({
			stream: "my-test-stream",
			storageClass: "express",
		});

		const call = vi.mocked(Generated.reconfigureStream).mock
			.calls[0]![0] as any;
		expect(call.path).toEqual({ stream: "my-test-stream" });
		expect(call.body).not.toHaveProperty("stream");
		expect(call.body.storage_class).toBe("express");
	});

	it("actual basins.reconfigure sends the basin name only in path", async () => {
		const basins = new S2Basins({} as any, {} as any);

		await basins.reconfigure({
			basin: "my-test-basin",
			createStreamOnAppend: true,
		});

		const call = vi.mocked(Generated.reconfigureBasin).mock.calls[0]![0] as any;
		expect(call.path).toEqual({ basin: "my-test-basin" });
		expect(call.body).not.toHaveProperty("basin");
		expect(call.body.create_stream_on_append).toBe(true);
	});
});
