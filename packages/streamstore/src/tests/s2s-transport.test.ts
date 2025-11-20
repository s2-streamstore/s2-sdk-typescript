import { describe, expect, it } from "vitest";
import { buildProtoAppendInput } from "../lib/stream/transport/s2s/index.js";
import type { AppendArgs, AppendRecord } from "../lib/stream/types.js";

const makeRecords = (): AppendRecord[] => [{ body: "hello" }];

describe("S2S transport proto serialization", () => {
	it("encodes match_seq_num = 0 instead of dropping it", () => {
		const records = makeRecords();
		const args: AppendArgs = {
			records,
			match_seq_num: 0,
		};

		const proto = buildProtoAppendInput(records, args);

		expect(proto.matchSeqNum).toBe(0n);
	});

	it("omits match_seq_num when it is undefined", () => {
		const records = makeRecords();
		const args: AppendArgs = {
			records,
		};

		const proto = buildProtoAppendInput(records, args);

		expect(proto.matchSeqNum).toBeUndefined();
	});
});
