import { describe, expect, it } from "vitest";
import { AppendInput, AppendRecord } from "../index.js";
import { buildProtoAppendInput } from "../lib/stream/transport/proto.js";
import { readQueryString } from "../lib/stream/transport/s2s/index.js";

const makeRecords = (): AppendRecord[] => [
	AppendRecord.string({ body: "hello" }),
];

describe("S2S transport proto serialization", () => {
	it("encodes matchSeqNum = 0 instead of dropping it", () => {
		const records = makeRecords();
		const input = AppendInput.create(records, { matchSeqNum: 0 });

		const proto = buildProtoAppendInput(input);

		// Proto stores as bigint internally
		expect(proto.matchSeqNum).toBe(0n);
	});

	it("omits matchSeqNum when it is undefined", () => {
		const records = makeRecords();
		const input = AppendInput.create(records);

		const proto = buildProtoAppendInput(input);

		expect(proto.matchSeqNum).toBeUndefined();
	});
});

describe("S2S read session query", () => {
	it("forwards clamp alongside the start position", () => {
		const params = new URLSearchParams(
			readQueryString({ seq_num: 999_999, clamp: true }),
		);
		expect(params.get("seq_num")).toBe("999999");
		expect(params.get("clamp")).toBe("true");
	});

	it("forwards an explicit clamp=false", () => {
		expect(readQueryString({ tail_offset: 0, clamp: false })).toBe(
			"tail_offset=0&clamp=false",
		);
	});

	it("forwards every server-side read parameter and nothing else", () => {
		const params = new URLSearchParams(
			readQueryString({
				timestamp: 1_700_000_000_000,
				clamp: true,
				count: 10,
				bytes: 1024,
				wait: 30,
				until: 1_700_000_100_000,
				as: "bytes",
				ignore_command_records: true,
			}),
		);
		expect([...params.keys()].sort()).toEqual([
			"bytes",
			"clamp",
			"count",
			"timestamp",
			"until",
			"wait",
		]);
	});

	it("omits unset parameters", () => {
		expect(readQueryString(undefined)).toBe("");
		expect(readQueryString({})).toBe("");
		expect(readQueryString({ seq_num: 0 })).toBe("seq_num=0");
	});
});
