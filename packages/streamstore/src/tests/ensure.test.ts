import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../generated/index.js", async () => {
	const actual = await vi.importActual<typeof import("../generated/index.js")>(
		"../generated/index.js",
	);
	return {
		...actual,
		ensureBasin: vi.fn(),
		ensureStream: vi.fn(),
	};
});

import { S2Basins } from "../basins.js";
import * as Generated from "../generated/index.js";
import { S2Streams } from "../streams.js";

describe("ensure provisioning", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("ensures a basin and parses the provisioning result header", async () => {
		vi.mocked(Generated.ensureBasin).mockResolvedValue({
			data: {
				created_at: "2024-01-01T00:00:00Z",
				deleted_at: null,
				name: "demo-basin",
			},
			response: {
				headers: new Headers({ "s2-provision-result": "noop" }),
				status: 200,
			},
		} as any);

		const basins = new S2Basins({} as any, {} as any);
		const response = await basins.ensure({ basin: "demo-basin" });

		expect(response).toEqual({
			result: "noop",
			basin: {
				createdAt: new Date("2024-01-01T00:00:00Z"),
				deletedAt: null,
				name: "demo-basin",
			},
		});

		const call = vi.mocked(Generated.ensureBasin).mock.calls[0]?.[0] as any;
		expect(call.path).toEqual({ basin: "demo-basin" });
		expect(call.body).toBeUndefined();
	});

	it("sends basin ensure config in wire format", async () => {
		vi.mocked(Generated.ensureBasin).mockResolvedValue({
			data: {
				created_at: "2024-01-01T00:00:00Z",
				deleted_at: null,
				name: "demo-basin",
			},
			response: {
				headers: new Headers({ "s2-provision-result": "updated" }),
				status: 200,
			},
		} as any);

		const basins = new S2Basins({} as any, {} as any);
		const response = await basins.ensure({
			basin: "demo-basin",
			config: {
				defaultStreamConfig: {
					retentionPolicy: { ageSecs: 3600 },
				},
			},
			location: "aws:us-west-2",
		});

		expect(response.result).toBe("updated");
		const call = vi.mocked(Generated.ensureBasin).mock.calls[0]?.[0] as any;
		expect(call.body.config.default_stream_config.retention_policy).toEqual({
			age: 3600,
		});
		expect(call.body.location).toBe("aws:us-west-2");
	});

	it("ensures a stream and falls back to 201 as created", async () => {
		vi.mocked(Generated.ensureStream).mockResolvedValue({
			data: {
				created_at: "2024-01-01T00:00:00Z",
				deleted_at: null,
				name: "events",
			},
			response: {
				headers: new Headers(),
				status: 201,
			},
		} as any);

		const streams = new S2Streams({} as any, {} as any);
		const response = await streams.ensure({ stream: "events" });

		expect(response.result).toBe("created");
		expect(response.stream).toMatchObject({
			deletedAt: null,
			name: "events",
		});
		expect(response.stream.createdAt).toBeInstanceOf(Date);

		const call = vi.mocked(Generated.ensureStream).mock.calls[0]?.[0] as any;
		expect(call.path).toEqual({ stream: "events" });
		expect(call.body).toBeUndefined();
	});

	it("sends stream ensure config in wire format", async () => {
		vi.mocked(Generated.ensureStream).mockResolvedValue({
			data: {
				created_at: "2024-01-01T00:00:00Z",
				deleted_at: null,
				name: "events",
			},
			response: {
				headers: new Headers({ "s2-provision-result": "updated" }),
				status: 200,
			},
		} as any);

		const streams = new S2Streams({} as any, {} as any);
		const response = await streams.ensure({
			stream: "events",
			config: {
				deleteOnEmpty: { minAgeSecs: 1.7 },
				retentionPolicy: { ageSecs: 3600 },
			},
		});

		expect(response.result).toBe("updated");
		const call = vi.mocked(Generated.ensureStream).mock.calls[0]?.[0] as any;
		expect(call.body.delete_on_empty).toEqual({ min_age_secs: 1 });
		expect(call.body.retention_policy).toEqual({ age: 3600 });
	});
});
