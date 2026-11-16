import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import {
	createServer as createHttp2Server,
	type Http2Server,
	type IncomingHttpHeaders,
	type ServerHttp2Session,
	type ServerHttp2Stream,
} from "node:http2";
import type { AddressInfo } from "node:net";
import type { S2 } from "../index.js";

export const TEST_TIMEOUT_MS = 120_000;

export const sleep = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));

export const makeBasinName = (prefix: string): string => {
	const suffix = Math.random().toString(36).slice(2, 10);
	return `${prefix}-${suffix}`.slice(0, 48);
};

export const makeStreamName = (prefix: string): string =>
	`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const isFreeTierLimitation = (err: unknown): boolean => {
	const message =
		err && typeof err === "object" && "message" in err
			? String((err as { message?: unknown }).message)
			: "";
	return message.toLowerCase().includes("free tier");
};

export const waitForBasinReady = async (
	s2: S2,
	basin: string,
	deadlineMs = 60_000,
): Promise<void> => {
	const start = Date.now();
	while (Date.now() - start < deadlineMs) {
		try {
			await s2.basins.getConfig({ basin });
			return;
		} catch (err) {
			const status =
				err && typeof err === "object" && "status" in err
					? (err as { status?: number }).status
					: undefined;
			if (status === 503) {
				await sleep(500);
				continue;
			}
			throw err;
		}
	}
	throw new Error(`Timed out waiting for basin ${basin} to become active`);
};

/** Fails instead of hanging if `promise` doesn't settle within `ms`. */
export function withinDeadline<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`did not settle within ${ms}ms`)),
			ms,
		);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Waits until `condition` holds, failing after `timeoutMs`. */
export async function waitFor(
	condition: () => boolean,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("condition not met in time");
		}
		await sleep(10);
	}
}

/** A local server on a free port. */
export interface LocalServer {
	origin: string;
	close: () => Promise<void>;
}

function listen(server: Server | Http2Server): Promise<string> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve(`http://127.0.0.1:${port}`);
		});
	});
}

/**
 * A plaintext HTTP/2 server that hands each stream to `onStream`. Session and
 * stream errors are ignored, and `close()` destroys open sessions so streams
 * a test holds open don't keep it from closing.
 */
export async function serveHttp2(
	onStream: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => void,
): Promise<
	LocalServer & {
		/** Sessions opened so far, closed or not. */
		sessionCount: () => number;
		openSessions: Set<ServerHttp2Session>;
		/** Streams not yet closed by either side. */
		open: () => number;
	}
> {
	const server = createHttp2Server();
	const openSessions = new Set<ServerHttp2Session>();
	let sessionCount = 0;
	let open = 0;
	server.on("sessionError", () => {});
	server.on("session", (session) => {
		sessionCount++;
		openSessions.add(session);
		session.on("error", () => {});
		session.on("close", () => openSessions.delete(session));
	});
	server.on("stream", (stream, headers) => {
		open++;
		stream.on("close", () => open--);
		stream.on("error", () => {});
		onStream(stream, headers);
	});
	return {
		origin: await listen(server),
		sessionCount: () => sessionCount,
		openSessions,
		open: () => open,
		close: () =>
			new Promise<void>((resolve) => {
				for (const session of openSessions) session.destroy();
				server.close(() => resolve());
			}),
	};
}

/**
 * An HTTP/1.1 server that hands each request to `onRequest`. `close()`
 * destroys open responses and connections so requests a test holds open
 * don't keep it from closing.
 */
export async function serveHttp1(
	onRequest: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<
	LocalServer & {
		/** Responses not yet closed by either side. */
		open: () => number;
	}
> {
	const responses = new Set<ServerResponse>();
	const server = createServer((req, res) => {
		responses.add(res);
		res.on("close", () => responses.delete(res));
		onRequest(req, res);
	});
	return {
		origin: await listen(server),
		open: () => responses.size,
		close: () =>
			new Promise<void>((resolve) => {
				for (const res of responses) res.destroy();
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
