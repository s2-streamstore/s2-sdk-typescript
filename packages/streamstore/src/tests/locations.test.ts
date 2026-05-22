import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../generated/index.js", async () => {
	const actual = await vi.importActual<typeof import("../generated/index.js")>(
		"../generated/index.js",
	);
	return {
		...actual,
		getDefaultLocation: vi.fn(),
		listLocations: vi.fn(),
		setDefaultLocation: vi.fn(),
	};
});

import * as Generated from "../generated/index.js";
import { S2Locations } from "../locations.js";

describe("locations", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("lists locations and converts response keys", async () => {
		vi.mocked(Generated.listLocations).mockResolvedValue({
			data: [
				{ name: "aws:us-east-1", is_private: false },
				{ name: "aws:us-west-2", is_private: true },
			],
		} as any);

		const locations = new S2Locations({} as any, {} as any);
		const response = await locations.list();

		expect(response).toEqual([
			{ name: "aws:us-east-1", isPrivate: false },
			{ name: "aws:us-west-2", isPrivate: true },
		]);

		const call = vi.mocked(Generated.listLocations).mock.calls[0]?.[0] as any;
		expect(call.client).toBeDefined();
	});

	it("gets the default location", async () => {
		vi.mocked(Generated.getDefaultLocation).mockResolvedValue({
			data: { name: "aws:us-east-1", is_private: false },
		} as any);

		const locations = new S2Locations({} as any, {} as any);
		const response = await locations.getDefault();

		expect(response).toEqual({
			name: "aws:us-east-1",
			isPrivate: false,
		});
	});

	it("sets the default location", async () => {
		vi.mocked(Generated.setDefaultLocation).mockResolvedValue({
			data: { name: "aws:us-west-2", is_private: false },
		} as any);

		const locations = new S2Locations({} as any, {} as any);
		const response = await locations.setDefault({
			location: "aws:us-west-2",
		});

		expect(response).toEqual({
			name: "aws:us-west-2",
			isPrivate: false,
		});

		const call = vi.mocked(Generated.setDefaultLocation).mock
			.calls[0]?.[0] as any;
		expect(call.body).toBe("aws:us-west-2");
	});
});
