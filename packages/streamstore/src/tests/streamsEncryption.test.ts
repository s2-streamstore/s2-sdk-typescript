import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../generated/index.js", async () => {
	const actual = await vi.importActual<typeof import("../generated/index.js")>(
		"../generated/index.js",
	);
	return {
		...actual,
		listStreams: vi.fn(),
	};
});

import * as Generated from "../generated/index.js";
import { S2Streams } from "../streams.js";

describe("Stream encryption metadata", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(Generated.listStreams).mockResolvedValue({
			data: { has_more: false, streams: [] },
			response: { status: 200 },
		} as any);
	});

	it("maps cipher from stream info responses", async () => {
		vi.mocked(Generated.listStreams).mockResolvedValue({
			data: {
				has_more: false,
				streams: [
					{
						cipher: "aegis-256",
						created_at: "2024-01-01T00:00:00Z",
						deleted_at: null,
						name: "events",
					},
				],
			},
			response: { status: 200 },
		} as any);

		const streams = new S2Streams({} as any);
		const response = await streams.list();

		expect(response.streams).toHaveLength(1);
		expect(response.streams[0]).toMatchObject({
			cipher: "aegis-256",
			deletedAt: null,
			name: "events",
		});
		expect(response.streams[0]?.createdAt).toBeInstanceOf(Date);
	});
});
