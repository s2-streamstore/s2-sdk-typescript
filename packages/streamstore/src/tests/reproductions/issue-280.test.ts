import { describe, expect, it, vi } from "vitest";

vi.mock("../../generated/index.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../generated/index.js")
	>("../../generated/index.js");
	return {
		...actual,
		createStream: vi.fn(),
	};
});

import * as Generated from "../../generated/index.js";
import { S2Streams } from "../../streams.js";

/**
 * Issue #280: create() returns StreamInfo (name, createdAt, deletedAt), but was
 * typed as { config } and skipped transformStreamInfo, so callers saw an
 * undefined `config` and dates left as raw strings.
 */
describe("Issue #280: create() returns normalized StreamInfo", () => {
	it("exposes StreamInfo fields with dates as Date objects", async () => {
		vi.mocked(Generated.createStream).mockResolvedValue({
			data: {
				created_at: "2024-01-01T00:00:00Z",
				deleted_at: null,
				name: "events",
			},
			response: { headers: new Headers(), status: 201 },
		} as any);

		const streams = new S2Streams({} as any, {} as any);
		const info = await streams.create({ stream: "events" });

		expect(info.name).toBe("events");
		expect(info.createdAt).toBeInstanceOf(Date);
		expect(info.deletedAt).toBeNull();
		expect((info as unknown as { config?: unknown }).config).toBeUndefined();
	});
});
