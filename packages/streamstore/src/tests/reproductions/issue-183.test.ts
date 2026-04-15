import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../generated/index.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../generated/index.js")
	>("../../generated/index.js");
	return {
		...actual,
		reconfigureStream: vi.fn(),
	};
});

import * as Generated from "../../generated/index.js";
import { S2Streams } from "../../streams.js";

/**
 * Issue #183: streams.reconfigure does not normalize deleteOnEmpty.minAgeSecs.
 *
 * The regression is in `S2Streams.reconfigure()`. These tests call the real
 * method and inspect the actual request body passed to the generated client.
 */

describe("Issue #183: streams.reconfigure must normalize deleteOnEmpty.minAgeSecs", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(Generated.reconfigureStream).mockResolvedValue({
			data: {},
			response: { status: 200 },
		} as any);
	});

	it("floors floating-point minAgeSecs values in the actual request body", async () => {
		const streams = new S2Streams({} as any);

		await streams.reconfigure({
			stream: "test-stream",
			deleteOnEmpty: { minAgeSecs: 3.7 },
		});

		const call = vi.mocked(Generated.reconfigureStream).mock
			.calls[0]![0] as any;
		expect(call.path).toEqual({ stream: "test-stream" });
		expect(call.body.delete_on_empty.min_age_secs).toBe(3);
	});

	it("clamps negative minAgeSecs to 0 in the actual request body", async () => {
		const streams = new S2Streams({} as any);

		await streams.reconfigure({
			stream: "test-stream",
			deleteOnEmpty: { minAgeSecs: -5 },
		});

		const call = vi.mocked(Generated.reconfigureStream).mock
			.calls[0]![0] as any;
		expect(call.path).toEqual({ stream: "test-stream" });
		expect(call.body.delete_on_empty.min_age_secs).toBe(0);
	});
});
