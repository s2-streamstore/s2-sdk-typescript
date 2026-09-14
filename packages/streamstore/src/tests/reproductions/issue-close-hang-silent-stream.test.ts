import http2, {
	type ServerHttp2Session,
	type ServerHttp2Stream,
} from "node:http2";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import * as Redacted from "../../lib/redacted.js";
import { S2STransport } from "../../lib/stream/transport/s2s/index.js";
import { AppendInput, AppendRecord } from "../../types.js";

const TEST_TIMEOUT_MS = 30_000;

interface SilentServer {
	origin: string;
	close: () => Promise<void>;
}

/**
 * Plaintext HTTP/2 server that responds 200 then stays silent for the entire
 * test (never acks, never closes, never RSTs). The server is NOT torn down
 * until the test ends, so the only thing that can unblock close() is a
 * client-side RST of the HTTP/2 stream. This models a silent server / network
 * black hole / intermediary that holds the HTTP/2 stream open without
 * forwarding acks.
 */
async function startSilentServer(): Promise<SilentServer> {
	const server = http2.createServer();
	const sessions = new Set<ServerHttp2Session>();

	server.on("sessionError", () => {});
	server.on("session", (s) => {
		sessions.add(s);
		s.on("error", () => {});
		s.on("close", () => sessions.delete(s));
	});
	server.on("stream", (stream: ServerHttp2Stream) => {
		stream.on("error", () => {});
		stream.respond({ ":status": 200 });
		stream.on("data", () => {});
		// Hold the stream open and silent for the lifetime of the test.
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address() as AddressInfo;

	return {
		origin: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve) => {
				for (const s of sessions) {
					try {
						s.destroy();
					} catch {}
				}
				server.close(() => resolve());
			}),
	};
}

describe("S2SAppendSession.close() does not hang on a silent HTTP/2 stream", () => {
	it(
		"close() resolves in bounded time while the server stays open and silent",
		async () => {
			const server = await startSilentServer();
			const transport = new S2STransport({
				baseUrl: `${server.origin}/v1`,
				accessToken: Redacted.make("token"),
				retry: {
					maxAttempts: 3,
					minBaseDelayMillis: 1,
					maxBaseDelayMillis: 5,
					requestTimeoutMillis: 200,
				},
			});
			try {
				const session = await transport.makeAppendSession("events");
				// Enqueue one batch. The pump writes it; the server never acks.
				await session.submit(
					AppendInput.create([AppendRecord.string({ body: "a" })]),
				);

				// Let the pump time out (200ms requestTimeout) and enter
				// recover(), which awaits the old session.close().
				await new Promise((r) => setTimeout(r, 600));

				const startedAt = Date.now();
				// With the RST-before-drain fix, each S2SAppendSession.close()
				// RSTs its stream so the "close" event fires and safeError drains
				// pendingAcks; recover() completes, the retry pump exhausts its
				// attempts and aborts, and close() resolves in bounded time.
				// Unpatched, close() busy-waits forever on the silent stream and
				// this test times out.
				await session.close().catch(() => {});
				expect(Date.now() - startedAt).toBeLessThan(10_000);
			} finally {
				await server.close().catch(() => {});
				await transport.close().catch(() => {});
			}
		},
		TEST_TIMEOUT_MS,
	);
});
