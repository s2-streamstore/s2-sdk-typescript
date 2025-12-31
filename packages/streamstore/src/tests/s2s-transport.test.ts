import { describe, expect, it } from "vitest";
import { AppendInput, AppendRecord } from "../index.js";
import { buildProtoAppendInput } from "../lib/stream/transport/proto.js";

const makeRecords = (): AppendRecord[] => [
	AppendRecord.string({ body: "hello" }),
];

describe("S2S transport proto serialization", () => {
	it("encodes match_seq_num = 0 instead of dropping it", () => {
		const records = makeRecords();
		const args: Omit<AppendInput, "records" | "meteredBytes"> = {
			match_seq_num: 0,
		};

		const proto = buildProtoAppendInput(records, args);

		// Proto stores as bigint internally
		expect(proto.matchSeqNum).toBe(0n);
	});

	it("omits match_seq_num when it is undefined", () => {
		const records = makeRecords();
		const args: Omit<AppendInput, "records" | "meteredBytes"> = {};

		const proto = buildProtoAppendInput(records, args);

		expect(proto.matchSeqNum).toBeUndefined();
	});
});
