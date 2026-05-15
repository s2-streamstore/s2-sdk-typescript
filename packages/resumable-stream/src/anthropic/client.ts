import { type SubscribeOptions, subscribeSse } from "../client-utils.js";
import type { Chunk } from "./types.js";

export type { SubscribeOptions } from "../client-utils.js";
export type { Chunk } from "./types.js";

/**
 * Reads an Anthropic replay endpoint and yields the original stream events.
 * If the connection drops, it resumes from the last seen S2 record.
 */
export function subscribe(options: SubscribeOptions): AsyncIterable<Chunk> {
	return subscribeSse<Chunk>(options);
}
