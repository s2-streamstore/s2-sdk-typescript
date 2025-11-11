/**
 * Transport factory - selects the appropriate transport based on runtime
 */

import { supportsHttp2 } from "./runtime.js";
import { FetchTransport } from "./transport/fetch/index.js";
import type { SessionTransport, TransportConfig } from "./types.js";

/**
 * Create a transport instance based on the runtime environment
 *
 * - In Node.js with HTTP/2 support: uses S2STransport (binary protocol over HTTP/2)
 * - Everywhere else: uses FetchTransport (JSON over HTTP/1.1)
 *
 * @param config Transport configuration
 */
export async function createSessionTransport(
	config: TransportConfig,
): Promise<SessionTransport> {
	// Check if user explicitly disabled HTTP/2
	if (config?.forceTransport === "fetch") {
		return new FetchTransport(config);
	} else if (config?.forceTransport === "s2s") {
		const { S2STransport } = await import("./transport/s2s/index.js");
		return new S2STransport(config);
	}

	// Check if HTTP/2 is available
	if (supportsHttp2()) {
		// Dynamic import for Node.js-specific transport
		const { S2STransport } = await import("./transport/s2s/index.js");
		return new S2STransport(config);
	}

	// Fallback to fetch
	return new FetchTransport(config);
}
