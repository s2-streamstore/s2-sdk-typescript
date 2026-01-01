import { describe, expect, it } from "vitest";
import { AppendInput, AppendRecord } from "../index.js";
import { buildProtoAppendInput } from "../lib/stream/transport/proto.js";

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
