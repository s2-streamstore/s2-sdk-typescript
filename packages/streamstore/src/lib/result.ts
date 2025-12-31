/**
 * Result types for AppendSession operations.
 * Using discriminated unions for ergonomic error handling with TypeScript control flow analysis.
 */

import { S2Error } from "../error.js";
import type { AppendAck } from "../types.js";

/**
 * Result of an append operation.
 * Use discriminated union pattern: check `result.ok` to access either `value` or `error`.
 */
export type AppendResult =
	| { ok: true; value: AppendAck }
	| { ok: false; error: S2Error };

/**
 * Result of a close operation.
 */
export type CloseResult = { ok: true } | { ok: false; error: S2Error };

/**
 * Constructs a successful append result.
 */
export function ok(value: AppendAck): AppendResult {
	return { ok: true, value };
}

/**
 * Constructs a failed append result.
 */
export function err(error: S2Error): AppendResult {
	return { ok: false, error };
}

/**
 * Constructs a successful close result.
 */
export function okClose(): CloseResult {
	return { ok: true };
}

/**
 * Constructs a failed close result.
 */
export function errClose(error: S2Error): CloseResult {
	return { ok: false, error };
}

/**
 * Type guard to check if a result is successful.
 * Mainly for internal use; prefer `result.ok` for public API.
 */
export function isOk<T>(
	result: { ok: true; value: T } | { ok: false; error: S2Error },
): result is { ok: true; value: T } {
	return result.ok;
}
