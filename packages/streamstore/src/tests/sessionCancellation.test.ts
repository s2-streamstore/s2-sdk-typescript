import http, { type ServerResponse } from "node:http";
import http2, { type ServerHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { S2Error } from "../error.js";
import * as Proto from "../generated/proto/s2.js";
import { S2 } from "../index.js";
import { frameMessage } from "../lib/stream/transport/s2s/framing.js";
import type { SessionTransports } from "../lib/stream/types.js";
import { AppendInput, AppendRecord } from "../types.js";

const TEST_TIMEOUT_MS = 15_000;

/**
 * Local server for one transport. A read session gets one record (seq 0,
 * tail 1) and is then held open at the tail. Appends are acked.
 */
interface SessionServer {
	origin: string;
	/** Requests received so far, reads and appends. */
	requests: () => number;
	/** Resolves when the first request arrives. */
	requested: Promise<void>;
	close: () => Promise<void>;
}

interface SessionServerOptions {
	/**
	 * How reads are answered: with one record (default), not at all, with a
	 * batch that cannot be parsed, or (HTTP/1.1 only) with JSON headers and
	 * part of a body. The read is held open in every case.
	 */
	reads?: "batch" | "hold" | "malformed" | "partial";
}

const TRANSPORTS: SessionTransports[] = ["s2s", "fetch"];

const DEADLINE_MS = 2_000;

/** Fails instead of hanging if `promise` doesn't settle in time. */
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

function clientFor(server: SessionServer): S2 {
	return new S2({
		accessToken: "token",
		endpoints: { account: server.origin, basin: server.origin },
		retry: { maxAttempts: 3, minBaseDelayMillis: 1, maxBaseDelayMillis: 5 },
	});
}

function startSessionServer(
	transport: SessionTransports,
	options?: SessionServerOptions,
): Promise<SessionServer> {
	return transport === "s2s" ? startH2Server(options) : startH1Server(options);
}

function listen(server: http.Server | http2.Http2Server): Promise<string> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve(`http://127.0.0.1:${port}`);
		});
	});
}

function counter() {
	let count = 0;
	let onFirst!: () => void;
	const requested = new Promise<void>((resolve) => {
		onFirst = resolve;
	});
	return {
		requested,
		requests: () => count,
		record: () => {
			count++;
			onFirst();
		},
	};
}

async function startH2Server(
	options?: SessionServerOptions,
): Promise<SessionServer> {
	const server = http2.createServer();
	const sessions = new Set<ServerHttp2Session>();
	const { requested, requests, record } = counter();
	const malformedFrame = Buffer.from(
		frameMessage({ terminal: false, body: new Uint8Array([0x0a, 0x64]) }),
	);
	const batchFrame = Buffer.from(
		frameMessage({
			terminal: false,
			body: Proto.ReadBatch.toBinary({
				records: [
					{
						seqNum: 0n,
						timestamp: 1n,
						headers: [],
						body: new TextEncoder().encode("a"),
					},
				],
				tail: { seqNum: 1n, timestamp: 1n },
			}),
		}),
	);
	const ackFrame = Buffer.from(
		frameMessage({
			terminal: false,
			body: Proto.AppendAck.toBinary({
				start: { seqNum: 1n, timestamp: 1n },
				end: { seqNum: 2n, timestamp: 1n },
				tail: { seqNum: 2n, timestamp: 1n },
			}),
		}),
	);

	server.on("sessionError", () => {});
	server.on("session", (session) => {
		sessions.add(session);
		session.on("error", () => {});
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream, headers) => {
		record();
		stream.on("error", () => {});
		if (headers[":method"] === "POST") {
			stream.respond({ ":status": 200 });
			stream.on("data", () => stream.write(ackFrame));
			stream.on("end", () => stream.end());
			return;
		}
		if (options?.reads !== "hold") {
			stream.respond({ ":status": 200 });
			stream.write(
				options?.reads === "malformed" ? malformedFrame : batchFrame,
			);
		}
	});

	const origin = await listen(server);
	return {
		origin,
		requests,
		requested,
		close: () =>
			new Promise<void>((resolve) => {
				for (const session of sessions) session.destroy();
				server.close(() => resolve());
			}),
	};
}

async function startH1Server(
	options?: SessionServerOptions,
): Promise<SessionServer> {
	const responses = new Set<ServerResponse>();
	const { requested, requests, record } = counter();
	const batchEvent = `event: batch\ndata: ${JSON.stringify({
		records: [{ seq_num: 0, timestamp: 1, headers: [], body: "a" }],
		tail: { seq_num: 1, timestamp: 1 },
	})}\n\n`;
	const ack = JSON.stringify({
		start: { seq_num: 1, timestamp: 1 },
		end: { seq_num: 2, timestamp: 1 },
		tail: { seq_num: 2, timestamp: 1 },
	});

	const server = http.createServer((req, res) => {
		record();
		responses.add(res);
		res.on("close", () => responses.delete(res));
		if (req.method === "POST") {
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(ack);
			});
			return;
		}
		if (options?.reads === "partial") {
			res.writeHead(200, { "content-type": "application/json" });
			res.write('{"tail":');
			return;
		}
		if (options?.reads !== "hold") {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(
				options?.reads === "malformed"
					? "event: batch\ndata: not json\n\n"
					: batchEvent,
			);
		}
	});

	const origin = await listen(server);
	return {
		origin,
		requests,
		requested,
		close: () =>
			new Promise<void>((resolve) => {
				for (const res of responses) res.destroy();
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

type AbortPoint =
	| "before readSession()"
	| "right after readSession() is called"
	| "while the server holds the response"
	| "while the session waits at the tail";

const CASES: { when: AbortPoint; requests: number }[] = [
	{ when: "before readSession()", requests: 0 },
	{ when: "right after readSession() is called", requests: 0 },
	{ when: "while the server holds the response", requests: 1 },
	{ when: "while the session waits at the tail", requests: 1 },
];

/**
 * Issue #405: an s2s read session never saw an abort that came before its
 * HTTP/2 stream was set up, and ended quietly on a later one, while the fetch
 * transport rejected with the cancellation error. Whenever the signal aborts,
 * the session must end with that error, without retrying, on both transports.
 */
describe.each(TRANSPORTS)(
	"Issue #405: aborting a %s read session",
	(transport) => {
		it.each(CASES)(
			"ends with ABORTED when the signal aborts $when",
			async ({ when, requests }) => {
				const server: SessionServer = await startSessionServer(transport, {
					reads:
						when === "while the server holds the response" ? "hold" : "batch",
				});
				const stream = clientFor(server)
					.basin("test-basin")
					.stream("stream", { forceTransport: transport });
				const controller = new AbortController();
				try {
					if (when === "before readSession()") controller.abort();
					const opening = stream.readSession(
						{ start: { from: { seqNum: 0 } } },
						{ signal: controller.signal },
					);
					if (when === "right after readSession() is called")
						controller.abort();
					if (when === "while the server holds the response") {
						await server.requested;
						controller.abort();
					}
					const reading = opening.then(async (session) => {
						for await (const _ of session) {
							setTimeout(() => controller.abort(), 10);
						}
					});

					await expect(withinDeadline(reading)).rejects.toMatchObject({
						message: "Request cancelled",
						code: "ABORTED",
						status: 499,
					});
					expect(server.requests()).toBe(requests);
				} finally {
					await server.close();
					await withinDeadline(stream.close()).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);
	},
);

const FROM_START = { start: { from: { seqNum: 0 } } };

const record = () => AppendInput.create([AppendRecord.string({ body: "b" })]);

/**
 * Issue #406: `S2Stream.close()` with sessions open never settled on s2s when
 * the handle was the endpoint's last pool user, since a graceful HTTP/2 close
 * waits for open streams, and resolved at once otherwise. No transport ended
 * the sessions opened from the handle. It must end them, then settle, whether
 * or not another handle shares the connection.
 */
describe.each(TRANSPORTS)(
	"Issue #406: closing a %s stream handle",
	(transport) => {
		it.each([
			{ others: "no other handle on the endpoint", otherHandle: false },
			{ others: "another handle reading on the endpoint", otherHandle: true },
		])(
			"ends its sessions and settles with $others",
			async ({ otherHandle }) => {
				const server = await startSessionServer(transport);
				const basin = clientFor(server).basin("test-basin");
				const other = basin.stream("stream", { forceTransport: transport });
				const stream = basin.stream("stream", { forceTransport: transport });
				try {
					if (otherHandle) {
						const session = await other.readSession(FROM_START);
						await session[Symbol.asyncIterator]().next();
					}
					const session = await stream.readSession(FROM_START);
					const records = session[Symbol.asyncIterator]();
					await records.next();
					const appends = await stream.appendSession();
					await (await appends.submit(record())).ack();

					await withinDeadline(stream.close());
					await expect(withinDeadline(records.next())).rejects.toMatchObject({
						code: "ABORTED",
					});
					await expect(appends.submit(record())).rejects.toThrow(
						"AppendSession is closed",
					);
				} finally {
					await server.close();
					await withinDeadline(other.close()).catch(() => {});
					await withinDeadline(stream.close()).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		// A failed read must not keep its stream open: the server still holds it.
		it(
			"settles after one of its read sessions failed",
			async () => {
				const server = await startSessionServer(transport, {
					reads: "malformed",
				});
				const stream = clientFor(server)
					.basin("test-basin")
					.stream("stream", { forceTransport: transport });
				try {
					const session = await stream.readSession(FROM_START);
					await expect(
						withinDeadline(session[Symbol.asyncIterator]().next()),
					).rejects.toBeInstanceOf(S2Error);

					await withinDeadline(stream.close());
				} finally {
					await server.close();
					await withinDeadline(stream.close()).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);
	},
);

/**
 * `fetch` rejects with whatever reason the caller passed to `abort()`, so a
 * one-shot request aborted with a reason used to fail with status 0 instead
 * of `ABORTED`, also once its response had started.
 */
describe("aborting a one-shot request", () => {
	it(
		"fails with ABORTED whatever reason abort() is given",
		async () => {
			const server = await startSessionServer("fetch", { reads: "partial" });
			try {
				const stream = clientFor(server).basin("test-basin").stream("stream");
				const controller = new AbortController();
				const tail = stream.checkTail({ signal: controller.signal });
				await server.requested;
				// Let the response headers arrive, so the abort lands in the body.
				await new Promise((resolve) => setTimeout(resolve, 50));
				controller.abort("done");

				await expect(withinDeadline(tail)).rejects.toMatchObject({
					code: "ABORTED",
					status: 499,
				});
			} finally {
				await server.close();
			}
		},
		TEST_TIMEOUT_MS,
	);
});
