import http2, {
	type ServerHttp2Session,
	type ServerHttp2Stream,
} from "node:http2";
import net, { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { S2Error } from "../error.js";
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

interface BlackholeProxy {
	origin: string;
	/** Silently drop all traffic from now on, in both directions. */
	blackhole: () => void;
	close: () => Promise<void>;
}

/** TCP proxy in front of `target` that can stop forwarding without closing. */
async function startProxy(target: string): Promise<BlackholeProxy> {
	const { hostname, port } = new URL(target);
	const sockets = new Set<net.Socket>();
	let dropping = false;
	const pipe = (from: net.Socket, to: net.Socket) => {
		from.on("data", (chunk) => {
			if (!dropping) to.write(chunk);
		});
	};
	const server = net.createServer((client) => {
		const upstream = net.connect(Number(port), hostname);
		for (const socket of [client, upstream]) {
			sockets.add(socket);
			socket.on("error", () => {});
			socket.on("close", () => sockets.delete(socket));
		}
		pipe(client, upstream);
		pipe(upstream, client);
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const proxyPort = (server.address() as AddressInfo).port;
	return {
		origin: `http://127.0.0.1:${proxyPort}`,
		blackhole: () => {
			dropping = true;
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}

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
			const [{ stream: s1 }, { stream: s2 }] = await Promise.all([
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
			const streams = (
				await Promise.all([
					pool.request(server.origin, GET_HEADERS),
					pool.request(server.origin, GET_HEADERS),
					pool.request(server.origin, GET_HEADERS),
				])
			).map((pooled) => pooled.stream);

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
			const { stream: reused } = await pool.request(server.origin, GET_HEADERS);
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
			const { stream } = await pool.request(server.origin, GET_HEADERS);
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
			const { stream: first } = await pool.request(server.origin, GET_HEADERS);
			first.on("error", () => {});
			await waitFor(() => server.sessionCount() === 1);

			for (const session of server.openSessions()) {
				session.goaway();
			}
			await waitFor(() => pool.connectionCount(server.origin) === 0);

			const { stream: second } = await pool.request(server.origin, GET_HEADERS);
			await waitFor(() => server.sessionCount() === 2);

			first.close();
			second.close();
			server.endAllStreams();
			await pool.detach(server.origin);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"applies configured flow-control windows to new connections",
		async () => {
			const server = await newServer();
			const pool = new Http2ConnectionPool();
			const http2 = {
				initialStreamWindowSize: 2 * 1024 * 1024,
				connectionWindowSize: 4 * 1024 * 1024,
			};

			pool.attach(server.origin, http2);
			const { stream } = await pool.request(server.origin, GET_HEADERS, {
				http2,
			});
			await waitFor(() => server.sessionCount() === 1);
			const [session] = [...server.openSessions()];
			if (!session) throw new Error("no server session");

			// The client's SETTINGS frame carries the stream window; its
			// WINDOW_UPDATE raises the connection window the server may use.
			await waitFor(
				() =>
					session.remoteSettings.initialWindowSize ===
					http2.initialStreamWindowSize,
			);
			await waitFor(
				() => session.state.remoteWindowSize === http2.connectionWindowSize,
			);

			stream.close();
			server.endAllStreams();
			await pool.detach(server.origin, http2);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"does not share connections across different flow-control settings",
		async () => {
			const server = await newServer();
			const pool = new Http2ConnectionPool();
			const a = { initialStreamWindowSize: 1024 * 1024 };
			const b = { initialStreamWindowSize: 2 * 1024 * 1024 };

			pool.attach(server.origin, a);
			pool.attach(server.origin, b);
			const { stream: s1 } = await pool.request(server.origin, GET_HEADERS, {
				http2: a,
			});
			const { stream: s2 } = await pool.request(server.origin, GET_HEADERS, {
				http2: b,
			});

			expect(pool.connectionCount(server.origin, a)).toBe(1);
			expect(pool.connectionCount(server.origin, b)).toBe(1);
			await waitFor(() => server.sessionCount() === 2);

			s1.close();
			s2.close();
			server.endAllStreams();

			// Detaching one settings bucket leaves the other's connection open.
			await pool.detach(server.origin, a);
			await sleep(50);
			expect(server.openSessions().size).toBe(1);

			await pool.detach(server.origin, b);
			await waitFor(() => server.openSessions().size === 0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"shares a connection across users attached with equal settings",
		async () => {
			const server = await newServer();
			const pool = new Http2ConnectionPool();
			const settings = () => ({ initialStreamWindowSize: 1024 * 1024 });

			pool.attach(server.origin, settings());
			pool.attach(server.origin, settings());
			const { stream: s1 } = await pool.request(server.origin, GET_HEADERS, {
				http2: settings(),
			});
			const { stream: s2 } = await pool.request(server.origin, GET_HEADERS, {
				http2: settings(),
			});

			expect(pool.connectionCount(server.origin, settings())).toBe(1);
			await waitFor(() => server.sessionCount() === 1);

			s1.close();
			s2.close();
			server.endAllStreams();
			await pool.detach(server.origin, settings());
			await pool.detach(server.origin, settings());
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"rejects invalid flow-control window sizes",
		async () => {
			const pool = new Http2ConnectionPool();
			const origin = "http://127.0.0.1:1";

			expect(() => pool.attach(origin, { initialStreamWindowSize: 0 })).toThrow(
				/initialStreamWindowSize/,
			);
			expect(() =>
				pool.attach(origin, { connectionWindowSize: 2 ** 31 }),
			).toThrow(/connectionWindowSize/);
			expect(() =>
				pool.attach(origin, {
					initialStreamWindowSize: 1.5 * 1024 * 1024 + 0.5,
				}),
			).toThrow(/initialStreamWindowSize/);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"replaces a connection that died on the next request",
		async () => {
			const server = await newServer();
			const pool = new Http2ConnectionPool();

			pool.attach(server.origin);
			const { stream: first } = await pool.request(server.origin, GET_HEADERS);
			first.on("error", () => {});
			await waitFor(() => server.sessionCount() === 1);

			for (const session of server.openSessions()) {
				session.destroy();
			}
			await waitFor(() => pool.connectionCount(server.origin) === 0);

			const { stream: second } = await pool.request(server.origin, GET_HEADERS);
			await waitFor(() => server.sessionCount() === 2);

			second.close();
			server.endAllStreams();
			await pool.detach(server.origin);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"keeps a connection with open streams while pings are answered",
		async () => {
			const server = await newServer();
			const pool = new Http2ConnectionPool({
				keepAliveIntervalMillis: 20,
				keepAliveTimeoutMillis: 50,
			});

			pool.attach(server.origin);
			const { stream } = await pool.request(server.origin, GET_HEADERS);
			await sleep(300);

			expect(stream.closed).toBe(false);
			expect(pool.connectionCount(server.origin)).toBe(1);

			stream.close();
			server.endAllStreams();
			await pool.detach(server.origin);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"destroys a connection whose keep-alive pings go unanswered",
		async () => {
			const server = await newServer();
			const proxy = await startProxy(server.origin);
			const pool = new Http2ConnectionPool({
				keepAliveIntervalMillis: 20,
				keepAliveTimeoutMillis: 50,
			});

			try {
				pool.attach(proxy.origin);
				const { stream } = await pool.request(proxy.origin, GET_HEADERS);
				const failed = new Promise<Error>((resolve) => {
					stream.on("error", resolve);
				});
				await waitFor(() => server.sessionCount() === 1);

				proxy.blackhole();

				await expect(failed).resolves.toMatchObject({
					code: "KEEP_ALIVE_TIMEOUT",
				});
				await waitFor(() => pool.connectionCount(proxy.origin) === 0);
				await pool.detach(proxy.origin);
			} finally {
				await proxy.close();
			}
		},
		TEST_TIMEOUT_MS,
	);
});

describe("S2STransport http2 settings", () => {
	it(
		"plumbs configured windows through to the pooled connection",
		async () => {
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
				const transport = new S2STransport({
					baseUrl: `${server.origin}/v1`,
					accessToken: Redacted.make("test-token"),
					http2: {
						initialStreamWindowSize: 3 * 1024 * 1024,
						connectionWindowSize: 5 * 1024 * 1024,
					},
				});

				const session = await transport.makeReadSession("test-stream");
				for await (const _record of session) {
					// terminal frame carries no records
				}

				const [serverSession] = [...server.openSessions()];
				if (!serverSession) throw new Error("no server session");
				await waitFor(
					() =>
						serverSession.remoteSettings.initialWindowSize === 3 * 1024 * 1024,
				);
				// The terminal frame consumed a few bytes of the window already.
				await waitFor(
					() =>
						(serverSession.state.remoteWindowSize ?? 0) >=
						5 * 1024 * 1024 - 1024,
				);

				await transport.close();
				await waitFor(() => server.openSessions().size === 0);
			} finally {
				await server.close().catch(() => {});
			}
		},
		TEST_TIMEOUT_MS,
	);
});

describe("S2STransport read cancellation", () => {
	it(
		"does not enqueue after cancellation closes a partial frame",
		async () => {
			let resolveStreamStarted: (() => void) | undefined;
			const streamStarted = new Promise<void>((resolve) => {
				resolveStreamStarted = resolve;
			});
			const server = await startServer((stream) => {
				stream.write(Buffer.from([0, 0, 8, 0, 1]));
				resolveStreamStarted?.();
			});

			try {
				const transport = new S2STransport({
					baseUrl: `${server.origin}/v1`,
					accessToken: Redacted.make("test-token"),
				});
				const session = await transport.makeReadSession("test-stream");
				await streamStarted;
				await sleep(50);

				await session.cancel();
				await sleep(50);
				await transport.close();
			} finally {
				await server.close().catch(() => {});
			}
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

// Regression test for: tail-idle timer (TAIL_TIMEOUT_MS = 20s in
// S2SReadSession) leaks the pooled HTTP/2 stream. When the timer fires, the
// read session enqueues a 408 TIMEOUT result into the ReadableStream
// controller and closes the controller, but never closes the underlying
// ClientHttp2Stream. Once `controller.close()` runs, the underlying-source
// `cancel` algorithm is unreachable (per the WHATWG streams spec,
// ReadableStreamCancel returns early when the stream is not in the "readable"
// state), so the retry layer's subsequent `session.cancel("retry")` is a
// silent no-op. The leaked stream keeps `activeStreams` pinned at 1 forever
// (it only decrements on stream 'close'), the keep-alive pings keep the
// connection healthy, and `transport.close()` hangs in `detach()`'s awaited
// `session.close()` (graceful close waits for in-flight streams). The fix
// closes the HTTP/2 stream before erroring the controller, matching every
// other error path in S2SReadSession.
describe("S2STransport tail-read timeout", () => {
	// TAIL_TIMEOUT_MS is 20s; the test waits for it to fire, then verifies
	// close() does not hang on the leaked stream.
	const TAIL_TIMEOUT_TEST_MS = 30_000;
	// transport.close() should complete promptly once the leaked stream is
	// closed. Without the fix, it hangs indefinitely — fail fast instead.
	const CLOSE_DEADLINE_MS = 5_000;

	it(
		"closes the underlying HTTP/2 stream when the tail-idle timer fires, releasing the pool slot",
		async () => {
			const server = await startServer((_stream) => {
				// `startServer` already responds with `:status: 200` and
				// attaches a stream "error" handler for us. We deliberately
				// never send a body frame here, so the client's 20s
				// tail-idle timer (TAIL_TIMEOUT_MS) fires.
			});

			try {
				const transport = new S2STransport({
					baseUrl: `${server.origin}/v1`,
					accessToken: Redacted.make("test-token"),
					retry: {
						maxAttempts: 1,
						minBaseDelayMillis: 1,
						maxBaseDelayMillis: 1,
					},
				});

				const session = await transport.makeReadSession("test-stream");

				// Iterate until the tail-idle timer fires and surfaces a
				// TIMEOUT result. The retry layer converts that into a stream
				// error that for-await-of rethrows.
				let caught: unknown;
				try {
					for await (const _ of session) {
						// Server never sends a record; no iterations expected.
					}
				} catch (err) {
					caught = err;
				}
				expect(caught).toBeInstanceOf(S2Error);
				expect(caught as S2Error).toMatchObject({
					code: "TIMEOUT",
					status: 408,
				});

				// transport.close() awaits a graceful session close. Without
				// the fix, the leaked HTTP/2 stream keeps `activeStreams > 0`
				// forever and keep-alive pings keep the connection healthy,
				// so session.close() never completes. The deadline fails the
				// test fast instead of hanging.
				let closeTimer: ReturnType<typeof setTimeout> | undefined;
				const closeDeadline = new Promise<never>((_, reject) => {
					closeTimer = setTimeout(
						() =>
							reject(
								new Error(
									`transport.close() did not settle within ${CLOSE_DEADLINE_MS}ms`,
								),
							),
						CLOSE_DEADLINE_MS,
					);
				});
				try {
					await Promise.race([transport.close(), closeDeadline]);
				} finally {
					if (closeTimer) clearTimeout(closeTimer);
				}

				// After close, no leaked stream holds the server-side session.
				await waitFor(() => server.openSessions().size === 0);
			} finally {
				await server.close().catch(() => {});
			}
		},
		TAIL_TIMEOUT_TEST_MS,
	);
});
