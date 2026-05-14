import { type SubscribeSseOptions, subscribeSse } from "../client-utils.js";
import type { Chunk } from "./types.js";

export type { Chunk } from "./types.js";

/** Options for `subscribe`. */
export type SubscribeOptions = SubscribeSseOptions;

/**
 * Tails an Anthropic resumable-chat replay. Yields parsed Anthropic events;
 * reconnects with `?from=<seqNum>` on body drop or fetch failure; ends on
 * HTTP 204, abort, or empty backoff schedule.
 */
export function subscribe(options: SubscribeOptions): AsyncIterable<Chunk> {
	return subscribeSse<Chunk>(options);
}
