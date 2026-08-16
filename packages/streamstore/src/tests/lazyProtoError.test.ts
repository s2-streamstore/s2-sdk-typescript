import { describe, expect, it, vi } from "vitest";
import { S2Error } from "../error.js";
import type { Client } from "../generated/client/index.js";
import { streamAppend } from "../lib/stream/transport/fetch/shared.js";
import type { AppendInput } from "../types.js";

const append = vi.hoisted(() => vi.fn());

vi.mock("../generated/index.js", () => ({
	append,
	read: vi.fn(),
}));

vi.mock("../lib/stream/transport/proto.js", () => {
	throw new TypeError("Failed to fetch");
});

describe("lazy protobuf codec errors", () => {
	it("normalizes module-loading failures", async () => {
		const input: AppendInput = {
			records: [{ body: new Uint8Array([1]), meteredBytes: 9 }],
			meteredBytes: 9,
		};

		const error = await streamAppend("test-stream", {} as Client, input).catch(
			(caught) => caught,
		);

		expect(error).toBeInstanceOf(S2Error);
		expect(append).not.toHaveBeenCalled();
	});
});
