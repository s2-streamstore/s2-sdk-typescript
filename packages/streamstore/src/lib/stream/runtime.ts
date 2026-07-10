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
	| "react-native"
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

	// Check for React Native (before Node: Metro provides a `process` shim)
	if (typeof navigator !== "undefined" && navigator.product === "ReactNative") {
		return "react-native";
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
			return true;

		case "deno":
			// Deno's node:http2 has data-chunking differences that cause
			// "premature EOF" errors in the s2s frame parser.
			// Fall back to fetch transport until Deno's compat improves.
			return false;

		case "bun":
			// Bun < 1.3.11 never sends connection-level WINDOW_UPDATE frames, so
			// HTTP/2 reads stall at 64 KiB (issue #113, fixed by oven-sh/bun#26917).
			return Bun.semver.satisfies(Bun.version, ">=1.3.11");

		case "browser":
		case "workerd":
		case "react-native":
			// No raw HTTP/2 access in these runtimes
			return false;

		default:
			return false;
	}
}

/**
 * Check if the current runtime allows setting a custom User-Agent header.
 *
 * Only browsers enforce the Fetch spec's "forbidden header name" restriction
 * that prevents setting User-Agent. All server-side runtimes (Node, Bun,
 * Deno, Cloudflare Workers, etc.) allow it.
 */
export function canSetUserAgentHeader(runtime?: Runtime): boolean {
	const rt = runtime ?? detectRuntime();
	return rt !== "browser";
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
