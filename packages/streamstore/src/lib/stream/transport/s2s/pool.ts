/**
 * Shared HTTP/2 connection pool for the s2s transport.
 *
 * Connections are pooled per endpoint and HTTP/2 settings, opened lazily on
 * the first request. Each connection carries up to
 * `maxConcurrentStreamsPerConnection` concurrent streams; beyond that,
 * additional connections are opened.
 */

import type { OutgoingHttpHeaders } from "node:http";
import type { ClientHttp2Session, ClientHttp2Stream } from "node:http2";
import createDebug from "debug";
import { S2Error } from "../../../../error.js";
import type { Http2Settings } from "../../types.js";

const debug = createDebug("s2:s2s:pool");

// S2 advertises SETTINGS_MAX_CONCURRENT_STREAMS = 100; not a user knob.
const MAX_CONCURRENT_STREAMS_PER_CONNECTION = 100;
const DEFAULT_CONNECTION_TIMEOUT_MS = 3000;
const DEFAULT_WINDOW_SIZE = 10 * 1024 * 1024; // 10 MiB
const MIN_WINDOW_SIZE = 65_535; // HTTP/2 default window
const MAX_WINDOW_SIZE = 2 ** 31 - 1; // RFC 9113 (https://www.rfc-editor.org/rfc/rfc9113.html#section-6.5.2-2.8.3)

interface ResolvedHttp2Settings {
	initialStreamWindowSize: number;
	connectionWindowSize: number;
}

function validateWindowSize(name: string, value: number): void {
	if (
		!Number.isInteger(value) ||
		value < MIN_WINDOW_SIZE ||
		value > MAX_WINDOW_SIZE
	) {
		throw new S2Error({
			message: `http2.${name} must be an integer between ${MIN_WINDOW_SIZE} and ${MAX_WINDOW_SIZE}, got ${value}`,
			status: 400,
			origin: "sdk",
		});
	}
}

function resolveHttp2Settings(settings?: Http2Settings): ResolvedHttp2Settings {
	const initialStreamWindowSize =
		settings?.initialStreamWindowSize ?? DEFAULT_WINDOW_SIZE;
	const connectionWindowSize =
		settings?.connectionWindowSize ?? DEFAULT_WINDOW_SIZE;
	validateWindowSize("initialStreamWindowSize", initialStreamWindowSize);
	validateWindowSize("connectionWindowSize", connectionWindowSize);
	return { initialStreamWindowSize, connectionWindowSize };
}

// Clients with equal resolved settings share connections to an origin.
function endpointKey(origin: string, settings: ResolvedHttp2Settings): string {
	return `${origin}|isw=${settings.initialStreamWindowSize}|cw=${settings.connectionWindowSize}`;
}

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
	origin: string;
	settings: ResolvedHttp2Settings;
}

interface RequestStreamOptions {
	connectionTimeoutMillis?: number;
	http2?: Http2Settings;
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
	 * Register as a user of an endpoint. Must be paired with a `detach` call
	 * with the same settings; connections are shared by all users attached
	 * with equal settings and closed on last detach.
	 */
	attach(origin: string, http2?: Http2Settings): void {
		const settings = resolveHttp2Settings(http2);
		const key = endpointKey(origin, settings);
		const endpoint = this.endpoints.get(key);
		if (endpoint) {
			endpoint.refCount += 1;
		} else {
			this.endpoints.set(key, {
				refCount: 1,
				connections: [],
				pending: [],
				origin,
				settings,
			});
		}
	}

	/**
	 * The inverse of `attach`. When the last user detaches, all connections
	 * to the endpoint are closed gracefully.
	 */
	async detach(origin: string, http2?: Http2Settings): Promise<void> {
		const key = endpointKey(origin, resolveHttp2Settings(http2));
		const endpoint = this.endpoints.get(key);
		if (!endpoint) {
			return;
		}
		endpoint.refCount -= 1;
		if (endpoint.refCount > 0) {
			return;
		}
		this.endpoints.delete(key);

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
		const key = endpointKey(origin, resolveHttp2Settings(options?.http2));
		for (let attempt = 0; attempt < 3; attempt++) {
			const endpoint = this.endpoints.get(key);
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
				pending = this.startConnect(key, endpoint, options);
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
	connectionCount(origin: string, http2?: Http2Settings): number {
		const key = endpointKey(origin, resolveHttp2Settings(http2));
		return this.endpoints.get(key)?.connections.length ?? 0;
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
		key: string,
		endpoint: Endpoint,
		options?: RequestStreamOptions,
	): PendingConnection {
		const connectPromise = this.connect(key, endpoint, options);
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
		key: string,
		endpoint: Endpoint,
		options?: RequestStreamOptions,
	): Promise<PooledConnection> {
		const { origin, settings } = endpoint;
		debug("connecting to %s", origin);
		const http2 = await loadHttp2();
		const session = http2.connect(origin, {
			// Headroom above the flow-control windows so Node's session memory
			// cap (default 10 MB) does not refuse streams when windows are raised.
			// This is just a heuristic to avoid memory issues in case.
			// Deno and Bun dont support this setting.
			maxSessionMemory: Math.max(
				10, // default maxSessionMemory
				Math.ceil(
					(settings.connectionWindowSize + settings.initialStreamWindowSize) /
						2 ** 20,
				) + 8, // 8 is a fixed overhead
			),
			settings: {
				initialWindowSize: settings.initialStreamWindowSize,
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
					session.setLocalWindowSize(settings.connectionWindowSize);
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
		session.on("goaway", () => this.evict(key, connection));
		session.on("close", () => this.evict(key, connection));
		session.on("error", () => this.evict(key, connection));

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

	private evict(key: string, connection: PooledConnection): void {
		connection.dead = true;
		const endpoint = this.endpoints.get(key);
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
