/**
 * Shared HTTP/2 connection pool for the s2s transport.
 *
 * One connection per endpoint, opened lazily on the first request. Each
 * connection carries up to `maxConcurrentStreamsPerConnection` concurrent
 * streams; beyond that, additional connections are opened.
 */

import type { OutgoingHttpHeaders } from "node:http";
import type { ClientHttp2Session, ClientHttp2Stream } from "node:http2";
import createDebug from "debug";
import { S2Error } from "../../../../error.js";

const debug = createDebug("s2:s2s:pool");

const MAX_CONCURRENT_STREAMS_PER_CONNECTION = 100;
const DEFAULT_CONNECTION_TIMEOUT_MS = 3000;
const INITIAL_WINDOW_SIZE = 10 * 1024 * 1024; // 10 MiB

type Http2Module = typeof import("node:http2");

let http2ModulePromise: Promise<Http2Module> | undefined;
async function loadHttp2(): Promise<Http2Module> {
	// Hint bundlers to skip bundling node:http2 while keeping the specifier static for type inference.
	if (!http2ModulePromise) {
		http2ModulePromise = import(
			/* webpackIgnore: true */
			/* @vite-ignore */
			"node:http2"
		);
	}
	return http2ModulePromise;
}

interface PooledConnection {
	session: ClientHttp2Session;
	activeStreams: number;
	dead: boolean;
}

interface PendingConnection {
	promise: Promise<PooledConnection>;
	reservations: number;
}

interface Endpoint {
	refCount: number;
	connections: PooledConnection[];
	pending: PendingConnection[];
}

interface RequestStreamOptions {
	connectionTimeoutMillis?: number;
}

export class Http2ConnectionPool {
	private readonly endpoints = new Map<string, Endpoint>();
	private readonly maxStreamsPerConnection: number;

	constructor(options?: { maxConcurrentStreamsPerConnection?: number }) {
		this.maxStreamsPerConnection =
			options?.maxConcurrentStreamsPerConnection ??
			MAX_CONCURRENT_STREAMS_PER_CONNECTION;
	}

	/**
	 * Register as a user of an endpoint. Must be paired with a `detach` call;
	 * connections are shared by all attached users and closed on last detach.
	 */
	attach(origin: string): void {
		const endpoint = this.endpoints.get(origin);
		if (endpoint) {
			endpoint.refCount += 1;
		} else {
			this.endpoints.set(origin, { refCount: 1, connections: [], pending: [] });
		}
	}

	/**
	 * The inverse of `attach`. When the last user detaches, all connections
	 * to the endpoint are closed gracefully.
	 */
	async detach(origin: string): Promise<void> {
		const endpoint = this.endpoints.get(origin);
		if (!endpoint) {
			return;
		}
		endpoint.refCount -= 1;
		if (endpoint.refCount > 0) {
			return;
		}
		this.endpoints.delete(origin);

		// Wait for in-progress connects; successful ones land in `connections`.
		await Promise.all(
			endpoint.pending.map((p) => p.promise.catch(() => undefined)),
		);
		debug(
			"closing %d connection(s) to %s",
			endpoint.connections.length,
			origin,
		);
		await Promise.all(
			endpoint.connections.map((connection) => {
				const { session } = connection;
				if (session.closed || session.destroyed) {
					return undefined;
				}
				return new Promise<void>((resolve) => {
					session.close(() => resolve());
				});
			}),
		);
	}

	/**
	 * Open a new HTTP/2 stream to the endpoint, reusing a pooled connection
	 * with spare capacity or opening a new one. Requires a prior `attach`.
	 */
	async request(
		origin: string,
		headers: OutgoingHttpHeaders,
		options?: RequestStreamOptions,
	): Promise<ClientHttp2Stream> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const endpoint = this.endpoints.get(origin);
			if (!endpoint) {
				throw new S2Error({
					message: `HTTP/2 connection pool is not attached to ${origin}`,
					status: 500,
					origin: "sdk",
				});
			}

			const usable = endpoint.connections.find(
				(c) => !c.dead && c.activeStreams < this.maxStreamsPerConnection,
			);
			if (usable) {
				return this.openStream(usable, headers);
			}

			// Join an in-progress connect if it still has room for this stream.
			let pending = endpoint.pending.find(
				(p) => p.reservations < this.maxStreamsPerConnection,
			);
			if (!pending) {
				pending = this.startConnect(origin, endpoint, options);
			}
			pending.reservations += 1;
			const connection = await pending.promise;
			if (connection.dead) {
				continue;
			}
			// The reservation was already counted into activeStreams on connect.
			return this.openStream(connection, headers, { reserved: true });
		}
		throw new S2Error({
			message: `HTTP/2 connections to ${origin} closed repeatedly before use`,
			status: 500,
			origin: "sdk",
		});
	}

	/** Number of live pooled connections to an endpoint. */
	connectionCount(origin: string): number {
		return this.endpoints.get(origin)?.connections.length ?? 0;
	}

	private openStream(
		connection: PooledConnection,
		headers: OutgoingHttpHeaders,
		opts?: { reserved: boolean },
	): ClientHttp2Stream {
		let stream: ClientHttp2Stream;
		try {
			stream = connection.session.request(headers);
		} catch (err) {
			if (opts?.reserved) {
				connection.activeStreams -= 1;
			}
			throw err;
		}
		if (!opts?.reserved) {
			connection.activeStreams += 1;
		}
		stream.once("close", () => {
			connection.activeStreams -= 1;
		});
		return stream;
	}

	private startConnect(
		origin: string,
		endpoint: Endpoint,
		options?: RequestStreamOptions,
	): PendingConnection {
		const connectPromise = this.connect(origin, options);
		const pending: PendingConnection = {
			reservations: 0,
			promise: connectPromise,
		};
		pending.promise = (async () => {
			try {
				const connection = await connectPromise;
				// Count reservations up front so requests arriving between now
				// and the reserved openStream calls cannot oversubscribe it.
				connection.activeStreams = pending.reservations;
				if (!connection.dead) {
					endpoint.connections.push(connection);
				}
				return connection;
			} finally {
				removeFrom(endpoint.pending, pending);
			}
		})();
		endpoint.pending.push(pending);
		return pending;
	}

	private async connect(
		origin: string,
		options?: RequestStreamOptions,
	): Promise<PooledConnection> {
		debug("connecting to %s", origin);
		const http2 = await loadHttp2();
		const session = http2.connect(origin, {
			settings: {
				initialWindowSize: INITIAL_WINDOW_SIZE,
			},
		});

		try {
			// Each pooled stream may add its own session listeners (e.g. goaway).
			session.setMaxListeners(0);
		} catch {
			// Not available in every runtime.
		}

		const connection: PooledConnection = {
			session,
			activeStreams: 0,
			dead: false,
		};

		const connectPromise = new Promise<PooledConnection>((resolve, reject) => {
			session.once("connect", () => {
				if (session.destroyed) return;
				try {
					session.setLocalWindowSize(INITIAL_WINDOW_SIZE);
				} catch {
					// Not available in every runtime; performance-only.
				}
				resolve(connection);
			});
			session.once("error", (err) => {
				reject(err);
			});
		});

		// A connection that errors or shuts down should get no new streams.
		// Its open streams observe the failure through their own events.
		session.on("goaway", () => this.evict(origin, connection));
		session.on("close", () => this.evict(origin, connection));
		session.on("error", () => this.evict(origin, connection));

		const connectionTimeout =
			options?.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS;

		let timeoutId: NodeJS.Timeout | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => {
				if (!session.closed && !session.destroyed) {
					session.destroy();
				}
				reject(
					new S2Error({
						message: `Connection timeout after ${connectionTimeout}ms`,
						status: 408,
						code: "CONNECTION_TIMEOUT",
						origin: "sdk",
					}),
				);
			}, connectionTimeout);
		});

		try {
			return await Promise.race([connectPromise, timeoutPromise]);
		} finally {
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
		}
	}

	private evict(origin: string, connection: PooledConnection): void {
		connection.dead = true;
		const endpoint = this.endpoints.get(origin);
		if (endpoint) {
			removeFrom(endpoint.connections, connection);
		}
		// The pool loses track of the connection here, so make sure it winds
		// down instead of relying on the server to close it.
		const { session } = connection;
		if (!session.closed && !session.destroyed) {
			session.close();
		}
	}
}

function removeFrom<T>(list: T[], item: T): void {
	const index = list.indexOf(item);
	if (index !== -1) {
		list.splice(index, 1);
	}
}

/** Process-wide pool shared by all s2s transports. */
export const sharedConnectionPool = new Http2ConnectionPool();
