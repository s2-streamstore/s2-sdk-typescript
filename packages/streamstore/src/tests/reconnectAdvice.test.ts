import { describe, expect, it } from "vitest";
import { RECONNECT_ADVISED_CODE, reconnectAdvisedError } from "../error.js";
import { AdvisedReconnects } from "../lib/reconnect.js";
import { isRetryable } from "../lib/retry.js";
import { S2SFrameParser } from "../lib/stream/transport/s2s/framing.js";

function rawFrame(flag: number, body = new Uint8Array(0)) {
	const length = 1 + body.length;
	return new Uint8Array([
		(length >> 16) & 0xff,
		(length >> 8) & 0xff,
		length & 0xff,
		flag,
		...body,
	]);
}

describe("reconnect advice frame flag", () => {
	it("parses the advice bit on regular frames", () => {
		const parser = new S2SFrameParser();
		parser.push(rawFrame(0x10, new Uint8Array([1, 2, 3])));
		const frame = parser.parseFrame();
		expect(frame).toMatchObject({
			terminal: false,
			compression: "none",
			reconnectAdvised: true,
		});
	});

	it("leaves the advice bit clear when unset", () => {
		const parser = new S2SFrameParser();
		parser.push(rawFrame(0x00, new Uint8Array([1])));
		expect(parser.parseFrame()?.reconnectAdvised).toBe(false);
	});

	it("reads the advice bit alongside compression", () => {
		const parser = new S2SFrameParser();
		parser.push(rawFrame(0x50, new Uint8Array([1])));
		expect(parser.parseFrame()).toMatchObject({
			compression: "gzip",
			reconnectAdvised: true,
		});
	});

	it("ignores the advice bit on terminal frames", () => {
		const parser = new S2SFrameParser();
		parser.push(rawFrame(0x90, new Uint8Array([0x01, 0xf4])));
		expect(parser.parseFrame()).toMatchObject({
			terminal: true,
			statusCode: 500,
			reconnectAdvised: false,
		});
	});
});

describe("reconnect advice error", () => {
	it("is retryable and free of side effects", () => {
		const error = reconnectAdvisedError();
		expect(error.code).toBe(RECONNECT_ADVISED_CODE);
		expect(error.status).toBe(503);
		expect(isRetryable(error)).toBe(true);
		expect(error.hasNoSideEffects()).toBe(true);
	});
});

describe("advised reconnect pacing", () => {
	it("allows three immediate reconnects before delaying", () => {
		const advised = new AdvisedReconnects();
		expect(advised.record(0)).toBe(0);
		expect(advised.record(1)).toBe(0);
		expect(advised.record(2)).toBe(0);
		expect(advised.record(3)).toBeGreaterThan(0);
	});

	it("resets the count once advice stops arriving", () => {
		const advised = new AdvisedReconnects();
		advised.record(0);
		advised.record(1);
		advised.record(2);
		advised.record(3);
		expect(advised.record(30_000)).toBe(0);
	});
});
