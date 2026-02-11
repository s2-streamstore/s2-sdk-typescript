import { VERSION } from "../../version.js";

/**
 * Runtime environment detection for transport selection
 */
export type Runtime =
	| "node"
	| "browser"
	| "deno"
	| "bun"
	| "workerd"
	| "unknown";

/**
 * Detect the current JavaScript runtime
 */
export function detectRuntime(): Runtime {
	// Check for Deno
	// @ts-expect-error - Deno global not in types
	if (typeof Deno !== "undefined") {
		return "deno";
	}

	// Check for Bun
	if (typeof Bun !== "undefined") {
		return "bun";
	}

	// Check for Cloudflare Workers
	// @ts-expect-error - WebSocketPair global is not in types
	if (typeof WebSocketPair !== "undefined") {
		return "workerd";
	}

	// Check for Node.js
	if (typeof process !== "undefined" && process.versions?.node !== undefined) {
		return "node";
	}

	// Check for browser
	if (typeof window !== "undefined" && typeof document !== "undefined") {
		return "browser";
	}

	return "unknown";
}

/**
 * Check if the current runtime supports HTTP/2 for s2s protocol
 */
export function supportsHttp2(): boolean {
	const runtime = detectRuntime();

	switch (runtime) {
		case "node":
		case "deno":
			return true;

		case "bun":
			// via node:http2
			// NOTE: bun's http2 support appears to be buggy, re: https://github.com/s2-streamstore/s2-sdk-typescript/issues/113
			// so we disable http2 for now
			return false;

		case "browser":
		case "workerd":
			// Browsers and workerd don't support raw HTTP/2
			return false;

		default:
			return false;
	}
}

/**
 * Check if the current runtime allows setting a custom User-Agent header.
 */
export function canSetUserAgentHeader(): boolean {
	const runtime = detectRuntime();

	switch (runtime) {
		case "node":
		case "bun":
			return true;
		default:
			return false;
	}
}

/**
 * Library version used in the default User-Agent header.
 *
 * The actual version string is injected at build time in the compiled
 * JavaScript output based on package.json. See src/version.ts and
 * scripts/postbuild.ts.
 */
export { VERSION };
export const DEFAULT_USER_AGENT = `s2-sdk-typescript/${VERSION}`;
