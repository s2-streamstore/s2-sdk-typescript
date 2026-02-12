import { describe, expect, it } from "vitest";
import { S2Error, s2Error } from "../error.js";

/**
 * Regression tests for issue #117:
 * Browser fetch errors (Chrome, Firefox, Safari) were not recognized as
 * connection errors by isConnectionError(), causing them to be classified
 * as unknown errors (status 0) instead of connection errors (status 502).
 */
describe("browser network error classification (#117)", () => {
	it("classifies Chrome 'Failed to fetch' as a connection error (status 502)", () => {
		const err = s2Error(new TypeError("Failed to fetch"));

		expect(err).toBeInstanceOf(S2Error);
		expect(err.status).toBe(502);
		expect(err.code).toBe("NETWORK_ERROR");
		expect(err.origin).toBe("sdk");
	});

	it("classifies Firefox 'NetworkError when attempting to fetch resource' as a connection error (status 502)", () => {
		const err = s2Error(
			new TypeError("NetworkError when attempting to fetch resource"),
		);

		expect(err).toBeInstanceOf(S2Error);
		expect(err.status).toBe(502);
		expect(err.code).toBe("NETWORK_ERROR");
		expect(err.origin).toBe("sdk");
	});

	it("classifies Safari 'Load failed' as a connection error (status 502)", () => {
		const err = s2Error(new TypeError("Load failed"));

		expect(err).toBeInstanceOf(S2Error);
		expect(err.status).toBe(502);
		expect(err.code).toBe("NETWORK_ERROR");
		expect(err.origin).toBe("sdk");
	});

	it("classifies Node.js 'fetch failed' as a connection error (status 502)", () => {
		const err = s2Error(new TypeError("fetch failed"));

		expect(err).toBeInstanceOf(S2Error);
		expect(err.status).toBe(502);
		expect(err.code).toBe("NETWORK_ERROR");
		expect(err.origin).toBe("sdk");
	});

	it("does NOT classify unrelated TypeError as a connection error", () => {
		const err = s2Error(new TypeError("Cannot read properties of undefined"));

		expect(err).toBeInstanceOf(S2Error);
		expect(err.status).toBe(0);
		expect(err.message).toBe("Cannot read properties of undefined");
	});

	it("classifies Node.js ECONNREFUSED via error code as a connection error (status 502)", () => {
		const fetchErr = new TypeError("fetch failed");
		(fetchErr as any).cause = { code: "ECONNREFUSED" };
		const err = s2Error(fetchErr);

		expect(err).toBeInstanceOf(S2Error);
		expect(err.status).toBe(502);
		expect(err.code).toBe("ECONNREFUSED");
	});

	it("classifies ENOTFOUND as a DNS error (status 400, not retryable)", () => {
		const fetchErr = new TypeError("fetch failed");
		(fetchErr as any).cause = { code: "ENOTFOUND" };
		const err = s2Error(fetchErr);

		expect(err).toBeInstanceOf(S2Error);
		expect(err.status).toBe(400);
		expect(err.code).toBe("ENOTFOUND");
	});
});
