import { getEventListeners } from "node:events";
import http, { type ServerResponse } from "node:http";
import http2, { type ServerHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { S2Error } from "../error.js";
import * as Proto from "../generated/proto/s2.js";
import { S2 } from "../index.js";
import { frameMessage } from "../lib/stream/transport/s2s/framing.js";
import type { SessionTransports } from "../lib/stream/types.js";
import type { S2Stream } from "../stream.js";
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
	close: () => Promise<void>;
}

interface SessionServerOptions {
	/**
	 * How reads are answered: with one record and then held open at the tail
	 * (default), not at all, with a batch that cannot be parsed and then held
	 * open, or with two records well short of the tail and then ended, as a
	 * read that reached its limit.
	 */
	reads?: "batch" | "hold" | "malformed" | "bounded";
}

const TRANSPORTS: SessionTransports[] = ["s2s", "fetch"];

const FROM_START = { start: { from: { seqNum: 0 } } };

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

// Run in order after each test: servers first, so a handle that cannot close
// cleanly is not left waiting on a live server.
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup().catch(() => {});
	}
});

/** A server for `transport`, closed after the test. */
async function startSessionServer(
	transport: SessionTransports,
	options?: SessionServerOptions,
): Promise<SessionServer> {
	const server =
		transport === "s2s"
			? await startH2Server(options)
			: await startH1Server(options);
	cleanups.push(server.close);
	return server;
}

/** A stream handle on `server`, closed after the test. */
function streamOn(
	server: SessionServer,
	transport: SessionTransports,
): S2Stream {
	const stream = new S2({
		accessToken: "token",
		endpoints: { account: server.origin, basin: server.origin },
		retry: { maxAttempts: 3, minBaseDelayMillis: 1, maxBaseDelayMillis: 5 },
	})
		.basin("test-basin")
		.stream("stream", { forceTransport: transport });
	cleanups.push(() => withinDeadline(stream.close()));
	return stream;
}

function listen(server: http.Server | http2.Http2Server): Promise<string> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve(`http://127.0.0.1:${port}`);
		});
	});
}

async function startH2Server(
	options?: SessionServerOptions,
): Promise<SessionServer> {
	const server = http2.createServer();
	const sessions = new Set<ServerHttp2Session>();
	let requests = 0;
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
	const boundedFrames = Buffer.concat([
		frameMessage({
			terminal: false,
			body: Proto.ReadBatch.toBinary({
				records: ["a", "b"].map((body, seqNum) => ({
					seqNum: BigInt(seqNum),
					timestamp: 1n,
					headers: [],
					body: new TextEncoder().encode(body),
				})),
				tail: { seqNum: 100n, timestamp: 1n },
			}),
		}),
		frameMessage({ terminal: true, statusCode: 200, body: new Uint8Array(0) }),
	]);
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
		requests++;
		stream.on("error", () => {});
		if (headers[":method"] === "POST") {
			stream.respond({ ":status": 200 });
			stream.on("data", () => stream.write(ackFrame));
			stream.on("end", () => stream.end());
			return;
		}
		if (options?.reads === "bounded") {
			stream.respond({ ":status": 200 });
			stream.end(boundedFrames);
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
		requests: () => requests,
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
	let requests = 0;
	const batchEvent = `event: batch\ndata: ${JSON.stringify({
		records: [{ seq_num: 0, timestamp: 1, headers: [], body: "a" }],
		tail: { seq_num: 1, timestamp: 1 },
	})}\n\n`;
	const boundedEvent = `event: batch\ndata: ${JSON.stringify({
		records: ["a", "b"].map((body, seq_num) => ({
			seq_num,
			timestamp: 1,
			headers: [],
			body,
		})),
		tail: { seq_num: 100, timestamp: 1 },
	})}\n\n`;
	const ack = JSON.stringify({
		start: { seq_num: 1, timestamp: 1 },
		end: { seq_num: 2, timestamp: 1 },
		tail: { seq_num: 2, timestamp: 1 },
	});

	const server = http.createServer((req, res) => {
		requests++;
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
		if (options?.reads === "bounded") {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(boundedEvent);
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
		requests: () => requests,
		close: () =>
			new Promise<void>((resolve) => {
				for (const res of responses) res.destroy();
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

const CASES = [
	{ when: "before readSession()", requests: 0 },
	{ when: "right after readSession() is called", requests: 0 },
	{ when: "while the server holds the response", requests: 1 },
	{ when: "while the session waits at the tail", requests: 1 },
] as const;

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
				const server = await startSessionServer(transport, {
					reads:
						when === "while the server holds the response" ? "hold" : "batch",
				});
				const stream = streamOn(server, transport);
				const controller = new AbortController();

				if (when === "before readSession()") controller.abort();
				const opening = stream.readSession(FROM_START, {
					signal: controller.signal,
				});
				if (when === "right after readSession() is called") controller.abort();
				if (when === "while the server holds the response") {
					await vi.waitFor(() => expect(server.requests()).toBe(1));
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
			},
			TEST_TIMEOUT_MS,
		);
	},
);

/**
 * Issue #142: a read session left its listener on the caller's signal after
 * it ended, so a long-lived signal shared by many sessions collected them.
 */
describe.each(TRANSPORTS)("Issue #142: a %s read session", (transport) => {
	it(
		"removes its listener from the caller's signal when it ends",
		async () => {
			const stream = streamOn(await startSessionServer(transport), transport);
			const signal = new AbortController().signal;

			const session = await stream.readSession(FROM_START, { signal });
			expect(getEventListeners(signal, "abort")).toHaveLength(1);
			for await (const _ of session) break;

			await vi.waitFor(
				() => expect(getEventListeners(signal, "abort")).toHaveLength(0),
				{ timeout: 2_000 },
			);
		},
		TEST_TIMEOUT_MS,
	);
});

const record = () => AppendInput.create([AppendRecord.string({ body: "b" })]);

/**
 * Issue #406: `S2Stream.close()` with sessions open never settled on s2s when
 * the handle was the endpoint's last pool user, since a graceful HTTP/2 close
 * waits for open streams, and resolved at once otherwise. No transport ended
 * the sessions opened from the handle. It must end them, then settle, whether
 * or not another handle shares the connection, and leave that handle's
 * sessions alone.
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
				let otherRecords: AsyncIterator<unknown> | undefined;
				if (otherHandle) {
					const other = streamOn(server, transport);
					otherRecords = (await other.readSession(FROM_START))[
						Symbol.asyncIterator
					]();
					await otherRecords.next();
				}
				const stream = streamOn(server, transport);
				const records = (await stream.readSession(FROM_START))[
					Symbol.asyncIterator
				]();
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
				if (otherRecords) {
					// Still waiting at the tail: neither failed nor reconnected.
					const outcome = await Promise.race([
						otherRecords.next().then(
							() => "delivered",
							(error) => `failed: ${error}`,
						),
						new Promise((resolve) => setTimeout(resolve, 100, "waiting")),
					]);
					expect(outcome).toBe("waiting");
				}
			},
			TEST_TIMEOUT_MS,
		);

		// A read that reached its limit has fetched every record, but the reader
		// has not taken them all yet.
		it(
			"ends a read session whose records are fetched but not yet read",
			async () => {
				const server = await startSessionServer(transport, {
					reads: "bounded",
				});
				const stream = streamOn(server, transport);
				const records = (
					await stream.readSession({
						...FROM_START,
						stop: { limits: { count: 2 } },
					})
				)[Symbol.asyncIterator]();
				await records.next();
				// Let the session fetch the second record and see the read end.
				await new Promise((resolve) => setTimeout(resolve, 50));

				await withinDeadline(stream.close());
				await expect(withinDeadline(records.next())).rejects.toMatchObject({
					code: "ABORTED",
				});
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
				const stream = streamOn(server, transport);

				const session = await stream.readSession(FROM_START);
				await expect(
					withinDeadline(session[Symbol.asyncIterator]().next()),
				).rejects.toBeInstanceOf(S2Error);
				await withinDeadline(stream.close());
			},
			TEST_TIMEOUT_MS,
		);
	},
);

/**
 * `fetch` rejects with whatever reason the caller passed to `abort()`, so a
 * one-shot request aborted with a reason used to fail with status 0 instead
 * of `ABORTED`.
 */
describe("aborting a one-shot request", () => {
	it(
		"fails with ABORTED whatever reason abort() is given",
		async () => {
			const server = await startSessionServer("fetch", { reads: "hold" });
			const stream = streamOn(server, "fetch");
			const controller = new AbortController();

			const tail = stream.checkTail({ signal: controller.signal });
			await vi.waitFor(() => expect(server.requests()).toBe(1));
			controller.abort("done");

			await expect(withinDeadline(tail)).rejects.toMatchObject({
				code: "ABORTED",
				status: 499,
			});
		},
		TEST_TIMEOUT_MS,
	);
});
