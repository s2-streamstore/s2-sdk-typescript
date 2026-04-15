import { describe, expect, it } from "vitest";
import { canSetUserAgentHeader } from "../../lib/stream/runtime.js";

/**
 * Issue #131: canSetUserAgentHeader is too conservative.
 *
 * Only browsers enforce the Fetch spec's "forbidden header name" restriction
 * that prevents setting User-Agent. Server-side runtimes (Node, Bun, Deno,
 * Cloudflare Workers) all allow it. The old implementation used an allowlist
 * (only Node and Bun returned true), which meant Deno, workerd, and unknown
 * server runtimes unnecessarily omitted the User-Agent header.
 *
 * The fix switches to a blocklist: only "browser" returns false.
 */

describe("Issue #131: canSetUserAgentHeader should allow all non-browser runtimes", () => {
	it("returns true for node", () => {
		expect(canSetUserAgentHeader("node")).toBe(true);
	});

	it("returns true for bun", () => {
		expect(canSetUserAgentHeader("bun")).toBe(true);
	});

	it("returns true for deno", () => {
		expect(canSetUserAgentHeader("deno")).toBe(true);
	});

	it("returns true for workerd (Cloudflare Workers)", () => {
		expect(canSetUserAgentHeader("workerd")).toBe(true);
	});

	it("returns true for unknown server runtimes", () => {
		expect(canSetUserAgentHeader("unknown")).toBe(true);
	});

	it("returns false for browser", () => {
		expect(canSetUserAgentHeader("browser")).toBe(false);
	});
});
