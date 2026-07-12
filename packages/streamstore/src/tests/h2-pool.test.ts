import http2, {
	type ServerHttp2Session,
	type ServerHttp2Stream,
} from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import * as Redacted from "../lib/redacted.js";
import { frameMessage } from "../lib/stream/transport/s2s/framing.js";
import { S2STransport } from "../lib/stream/transport/s2s/index.js";
import { Http2ConnectionPool } from "../lib/stream/transport/s2s/pool.js";
import { sleep } from "./helpers.js";

const TEST_TIMEOUT_MS = 15_000;

interface TestServer {
	origin: string;
	sessionCount: () => number;
	openSessions: () => Set<ServerHttp2Session>;
	heldStreams: ServerHttp2Stream[];
	endAllStreams: () => void;
	close: () => Promise<void>;
}

/**
 * Plaintext HTTP/2 server that responds 200 and holds streams open
 * until endAllStreams() is called.
 */
async function startServer(
	onStream?: (stream: ServerHttp2Stream) => void,
): Promise<TestServer> {
	const server = http2.createServer();
	const sessions = new Set<ServerHttp2Session>();
	let sessionCount = 0;
	const heldStreams: ServerHttp2Stream[] = [];

	server.on("sessionError", () => {});
	server.on("session", (session) => {
		sessionCount += 1;
		sessions.add(session);
		session.on("error", () => {});
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream) => {
		stream.on("error", () => {});
		stream.respond({ ":status": 200 });
		if (onStream) {
			onStream(stream);
		} else {
			heldStreams.push(stream);
		}
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = (server.address() as AddressInfo).port;

	return {
		origin: `http://127.0.0.1:${port}`,
		sessionCount: () => sessionCount,
		openSessions: () => sessions,
		heldStreams,
		endAllStreams: () => {
			for (const stream of heldStreams.splice(0)) {
				try {
					stream.end();
				} catch {}
			}
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const session of sessions) {
					session.destroy();
				}
				server.close(() => resolve());
			}),
	};
}

async function waitFor(
	condition: () => boolean,
	timeoutMs = 5000,
): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("condition not met in time");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

const GET_HEADERS = { ":method": "GET", ":path": "/" };

describe("Http2ConnectionPool", () => {
	const servers: TestServer[] = [];

	afterEach(async () => {
		await Promise.all(servers.splice(0).map((s) => s.close().catch(() => {})));
	});

	async function newServer(onStream?: (stream: ServerHttp2Stream) => void) {
		const server = await startServer(onStream);
		servers.push(server);
		return server;
	}

	it(
		"does not dial until the first request",
		async () => {
			const server = await newServer();
			const pool = new Http2ConnectionPool();

			pool.attach(server.origin);
			await sleep(50);
			expect(server.sessionCount()).toBe(0);

			await pool.detach(server.origin);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"rejects requests for endpoints that were never attached",
		async () => {
			const server = await newServer();
			const pool = new Http2ConnectionPool();

			await expect(pool.request(server.origin, GET_HEADERS)).rejects.toThrow(
				/not attached/,
			);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"coalesces concurrent requests onto a single connection within the cap",
		async () => {
			const server = await newServer();
			const pool = new Http2ConnectionPool({
				maxConcurrentStreamsPerConnection: 2,
			});

			pool.attach(server.origin);
			const [s1, s2] = await Promise.all([
				pool.request(server.origin, GET_HEADERS),
				pool.request(server.origin, GET_HEADERS),
			]);

			expect(pool.connectionCount(server.origin)).toBe(1);
			// The server observes the session slightly after the client connects.
			await waitFor(() => server.sessionCount() === 1);
			await sleep(50);
			expect(server.sessionCount()).toBe(1);

			s1.close();
			s2.close();
			server.endAllStreams();
			await pool.detach(server.origin);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"spills over to a new connection beyond the concurrency cap",
		async () => {
			const server = await newServer();
			const pool = new Http2ConnectionPool({
				maxConcurrentStreamsPerConnection: 2,
			});

			pool.attach(server.origin);
			const streams = await Promise.all([
				pool.request(server.origin, GET_HEADERS),
				pool.request(server.origin, GET_HEADERS),
				pool.request(server.origin, GET_HEADERS),
			]);

			expect(pool.connectionCount(server.origin)).toBe(2);
			await waitFor(() => server.sessionCount() === 2);
			await sleep(50);
			expect(server.sessionCount()).toBe(2);

			// Freed capacity is reused instead of opening a third connection.
			for (const stream of streams) {
				stream.close();
			}
			server.endAllStreams();
			await waitFor(() => streams.every((s) => s.closed));
			const reused = await pool.request(server.origin, GET_HEADERS);
			await sleep(50);
			expect(server.sessionCount()).toBe(2);

			reused.close();
			server.endAllStreams();
			await pool.detach(server.origin);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"closes connections only when the last attachment detaches",
		async () => {
			const server = await newServer();
			const pool = new Http2ConnectionPool();

			pool.attach(server.origin);
			pool.attach(server.origin);
			const stream = await pool.request(server.origin, GET_HEADERS);
			stream.close();
			server.endAllStreams();

			await pool.detach(server.origin);
			await sleep(50);
			expect(server.openSessions().size).toBe(1);

			await pool.detach(server.origin);
			await waitFor(() => server.openSessions().size === 0);
			expect(pool.connectionCount(server.origin)).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"evicts a connection on goaway and opens a new one",
		async () => {
			const server = await newServer();
			const pool = new Http2ConnectionPool();

			pool.attach(server.origin);
			const first = await pool.request(server.origin, GET_HEADERS);
			first.on("error", () => {});
			await waitFor(() => server.sessionCount() === 1);

			for (const session of server.openSessions()) {
				session.goaway();
			}
			await waitFor(() => pool.connectionCount(server.origin) === 0);

			const second = await pool.request(server.origin, GET_HEADERS);
			await waitFor(() => server.sessionCount() === 2);

			first.close();
			second.close();
			server.endAllStreams();
			await pool.detach(server.origin);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"replaces a connection that died on the next request",
		async () => {
			const server = await newServer();
			const pool = new Http2ConnectionPool();

			pool.attach(server.origin);
			const first = await pool.request(server.origin, GET_HEADERS);
			first.on("error", () => {});
			await waitFor(() => server.sessionCount() === 1);

			for (const session of server.openSessions()) {
				session.destroy();
			}
			await waitFor(() => pool.connectionCount(server.origin) === 0);

			const second = await pool.request(server.origin, GET_HEADERS);
			await waitFor(() => server.sessionCount() === 2);

			second.close();
			server.endAllStreams();
			await pool.detach(server.origin);
		},
		TEST_TIMEOUT_MS,
	);
});

describe("S2STransport connection sharing", () => {
	it(
		"shares one connection across transports and closes it on last close",
		async () => {
			// The server replies with a terminal s2s frame (status 200), which ends a read session cleanly.
			const server = await startServer((stream) => {
				stream.end(
					Buffer.from(
						frameMessage({
							terminal: true,
							statusCode: 200,
							body: new Uint8Array(0),
						}),
					),
				);
			});

			try {
				const makeTransport = () =>
					new S2STransport({
						baseUrl: `${server.origin}/v1`,
						accessToken: Redacted.make("test-token"),
					});
				const transport1 = makeTransport();
				const transport2 = makeTransport();

				const drain = async (transport: S2STransport) => {
					const session = await transport.makeReadSession("test-stream");
					for await (const _record of session) {
						// terminal frame carries no records
					}
				};

				await drain(transport1);
				await drain(transport2);
				expect(server.sessionCount()).toBe(1);

				await transport1.close();
				await sleep(50);
				expect(server.openSessions().size).toBe(1);

				// The surviving transport still works over the pooled connection.
				await drain(transport2);
				expect(server.sessionCount()).toBe(1);

				await transport2.close();
				await waitFor(() => server.openSessions().size === 0);

				// A closed transport must not re-attach to the pool.
				await expect(drain(transport2)).rejects.toThrow(/closed/);
				await sleep(50);
				expect(server.openSessions().size).toBe(0);
			} finally {
				await server.close().catch(() => {});
			}
		},
		TEST_TIMEOUT_MS,
	);
});
