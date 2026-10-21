import http, { type ServerResponse } from "node:http";
import http2, { type ServerHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import * as Redacted from "../lib/redacted.js";
import { FetchTransport } from "../lib/stream/transport/fetch/index.js";
import { S2STransport } from "../lib/stream/transport/s2s/index.js";
import type { SessionTransport } from "../lib/stream/types.js";
import { AppendInput, AppendRecord } from "../types.js";

const TEST_TIMEOUT_MS = 15_000;

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 100;

const retry = {
	maxAttempts: MAX_ATTEMPTS,
	minBaseDelayMillis: 1,
	maxBaseDelayMillis: 1,
	requestTimeoutMillis: REQUEST_TIMEOUT_MS,
	appendRetryPolicy: "all" as const,
};

interface StallServer {
	origin: string;
	appends: () => number;
	close: () => Promise<void>;
}

function listen(server: http.Server | http2.Http2Server): Promise<string> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve(`http://127.0.0.1:${port}`);
		});
	});
}

/** HTTP/2 server that accepts append streams but never acks. */
async function startH2StallServer(): Promise<StallServer> {
	const server = http2.createServer();
	const sessions = new Set<ServerHttp2Session>();
	let appends = 0;
	server.on("sessionError", () => {});
	server.on("session", (session) => {
		sessions.add(session);
		session.on("error", () => {});
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream) => {
		appends++;
		stream.on("error", () => {});
		stream.respond({ ":status": 200 });
		stream.on("data", () => {});
	});
	const origin = await listen(server);
	return {
		origin,
		appends: () => appends,
		close: () =>
			new Promise<void>((resolve) => {
				for (const session of sessions) session.destroy();
				server.close(() => resolve());
			}),
	};
}

/** HTTP/1.1 server that reads append requests but never responds. */
async function startH1StallServer(): Promise<StallServer> {
	const responses = new Set<ServerResponse>();
	let appends = 0;
	const server = http.createServer((req, res) => {
		appends++;
		responses.add(res);
		res.on("close", () => responses.delete(res));
		req.resume();
	});
	const origin = await listen(server);
	return {
		origin,
		appends: () => appends,
		close: () =>
			new Promise<void>((resolve) => {
				for (const res of responses) res.destroy();
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

// Each attempt is bounded by the request timeout, not by the stalled request.
const DEADLINE_MS = MAX_ATTEMPTS * REQUEST_TIMEOUT_MS + 2_000;

/** Fails instead of hanging if `promise` doesn't settle by the deadline. */
function withinDeadline<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`did not settle within ${DEADLINE_MS}ms`)),
			DEADLINE_MS,
		);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function exercise(transport: SessionTransport, server: StallServer) {
	const session = await transport.makeAppendSession("events");
	const ticket = await session.submit(
		AppendInput.create([AppendRecord.string({ body: "a" })]),
	);

	await expect(withinDeadline(ticket.ack())).rejects.toThrow(
		`Max attempts (${MAX_ATTEMPTS}) exhausted`,
	);
	expect(server.appends()).toBe(MAX_ATTEMPTS);

	await expect(withinDeadline(session.close())).rejects.toThrow(
		`Max attempts (${MAX_ATTEMPTS}) exhausted`,
	);
}

describe("append session with a stalled server", () => {
	it(
		"times out and retries each attempt over s2s",
		async () => {
			const server = await startH2StallServer();
			const transport = new S2STransport({
				baseUrl: `${server.origin}/v1`,
				accessToken: Redacted.make("token"),
				retry,
			});
			try {
				await exercise(transport, server);
			} finally {
				await server.close().catch(() => {});
				await transport.close().catch(() => {});
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"times out and retries each attempt over fetch",
		async () => {
			const server = await startH1StallServer();
			const transport = new FetchTransport({
				baseUrl: `${server.origin}/v1`,
				accessToken: Redacted.make("token"),
				retry,
			});
			try {
				await exercise(transport, server);
			} finally {
				await server.close().catch(() => {});
			}
		},
		TEST_TIMEOUT_MS,
	);
});
