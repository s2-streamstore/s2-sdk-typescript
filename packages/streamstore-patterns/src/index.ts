/**
 * Entry point for @s2-dev/streamstore-patterns.
 *
 * This package is intended for higher-level, opinionated helpers
 * that build on top of the core @s2-dev/streamstore SDK.
 *
 * The core SDK has no dependency on this package; consumers can
 * choose to depend only on @s2-dev/streamstore if they prefer.
 */

import type { S2ClientOptions } from "@s2-dev/streamstore";

/**
 * Minimal example type tying patterns to the core SDK.
 * Real pattern helpers can build on this or replace it.
 */
export interface PatternContext {
	options: S2ClientOptions;
}

