/**
 * Runtime environment detection for transport selection
 */

export type Runtime = "node" | "browser" | "deno" | "bun" | "unknown";

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
		case "bun":
			// via node:http2
			return true;

		case "browser":
			// Browsers don't expose raw HTTP/2 - they handle it internally
			// but we can't use s2s protocol
			return false;

		default:
			return false;
	}
}
