import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../generated/index.js", async () => {
	const actual = await vi.importActual<typeof import("../generated/index.js")>(
		"../generated/index.js",
	);
	return {
		...actual,
		createBasin: vi.fn(),
		getBasinConfig: vi.fn(),
		reconfigureBasin: vi.fn(),
	};
});

import { S2Basins } from "../basins.js";
import * as Generated from "../generated/index.js";

describe("Basin encryption config", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(Generated.createBasin).mockResolvedValue({
			data: { name: "demo-basin", state: "active" },
			response: { status: 201 },
		} as any);
		vi.mocked(Generated.getBasinConfig).mockResolvedValue({
			data: {},
			response: { status: 200 },
		} as any);
		vi.mocked(Generated.reconfigureBasin).mockResolvedValue({
			data: {},
			response: { status: 200 },
		} as any);
	});

	it("sends streamCipher during basin creation", async () => {
		const basins = new S2Basins({} as any, {} as any);

		await basins.create({
			basin: "demo-basin",
			config: { streamCipher: "aegis-256" },
		});

		const call = vi.mocked(Generated.createBasin).mock.calls[0]?.[0] as any;
		expect(call.body.config.stream_cipher).toBe("aegis-256");
	});

	it("sends streamCipher during basin reconfiguration", async () => {
		const basins = new S2Basins({} as any, {} as any);

		await basins.reconfigure({
			basin: "demo-basin",
			streamCipher: "aes-256-gcm",
		});

		const call = vi.mocked(Generated.reconfigureBasin).mock
			.calls[0]?.[0] as any;
		expect(call.path).toEqual({ basin: "demo-basin" });
		expect(call.body.stream_cipher).toBe("aes-256-gcm");
	});

	it("maps stream_cipher from basin config responses", async () => {
		vi.mocked(Generated.getBasinConfig).mockResolvedValue({
			data: {
				stream_cipher: "aegis-256",
			},
			response: { status: 200 },
		} as any);

		const basins = new S2Basins({} as any, {} as any);
		const config = await basins.getConfig({ basin: "demo-basin" });

		expect(config.streamCipher).toBe("aegis-256");
	});
});
