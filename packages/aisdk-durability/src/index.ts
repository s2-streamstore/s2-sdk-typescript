/**
 * Vercel AI SDK transport adapters backed by S2.
 *
 * **Server** — {@link createS2ChatPersistence}
 *
 * Create once, call `persist()` per request to write AI chunks to S2 and
 * return a `{ stream }` response. Optionally expose `replay()` as a
 * server-side reconnect endpoint.
 *
 * **Client** — {@link createS2ChatTransport}
 *
 * Drop-in `ChatTransport` for `useChat` that reads directly from S2 over
 * SSE — no server proxy required.
 */

export { createS2ChatPersistence } from "./server.js";
export { createS2ChatTransport } from "./client.js";

export type {
	PersistOptions,
	S2ChatPersistence,
	S2ChatPersistenceConfig,
	S2ChatTransportConfig,
	S2ReadConfig,
} from "./types.js";
