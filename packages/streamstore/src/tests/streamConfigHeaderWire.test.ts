import http, { type IncomingMessage, type ServerResponse } from "node:http";
import http2, {
	type IncomingHttpHeaders,
	type ServerHttp2Session,
	type ServerHttp2Stream,
} from "node:http2";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import * as Proto from "../generated/proto/s2.js";
import * as Redacted from "../lib/redacted.js";
import { FetchTransport } from "../lib/stream/transport/fetch/index.js";
import { frameMessage } from "../lib/stream/transport/s2s/framing.js";
import { S2STransport } from "../lib/stream/transport/s2s/index.js";
import type { SessionTransport } from "../lib/stream/types.js";
import { S2_STREAM_CONFIG_HEADER } from "../lib/stream-config.js";
import { AppendInput, AppendRecord, type StreamConfig } from "../types.js";

const TEST_TIMEOUT_MS = 15_000;

const streamConfig: StreamConfig = {
	retentionPolicy: { ageSecs: 3600 },
	deleteOnEmpty: { minAgeSecs: 300 },
};

const expectedHeader = JSON.stringify({
	retention_policy: { age: 3600 },
	delete_on_empty: { min_age_secs: 300 },
});

type Captured = { method: string; path: string; header: string | undefined };

const failure = JSON.stringify({ message: "boom" });

/** Fails the first request of each method with a retryable 500. */
function firstAttemptFails() {
	const seen = new Set<string>();
	return (method: string) => {
		if (seen.has(method)) return false;
		seen.add(method);
		return true;
	};
}

interface TestServer {
	origin: string;
	requests: Captured[];
	close: () => Promise<void>;
}

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function listen(server: http.Server | http2.Http2Server): Promise<string> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve(`http://127.0.0.1:${port}`);
		});
	});
}

/**
 * HTTP/2 server: fails the first GET and POST with a 500, then holds GETs open
 * and acks every POST frame with an s2s AppendAck.
 */
async function startH2Server(): Promise<TestServer> {
	const server = http2.createServer();
	const sessions = new Set<ServerHttp2Session>();
	const streams = new Set<ServerHttp2Stream>();
	const requests: Captured[] = [];
	const shouldFail = firstAttemptFails();
	const ackFrame = Buffer.from(
		frameMessage({
			terminal: false,
			body: Proto.AppendAck.toBinary({
				start: { seqNum: 0n, timestamp: 1n },
				end: { seqNum: 1n, timestamp: 1n },
				tail: { seqNum: 1n, timestamp: 1n },
			}),
		}),
	);

	server.on("sessionError", () => {});
	server.on("session", (session) => {
		sessions.add(session);
		session.on("error", () => {});
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream, headers: IncomingHttpHeaders) => {
		requests.push({
			method: headers[":method"] ?? "",
			path: headers[":path"] ?? "",
			header: headers[S2_STREAM_CONFIG_HEADER] as string | undefined,
		});
		streams.add(stream);
		stream.on("error", () => {});
		stream.on("close", () => streams.delete(stream));
		if (shouldFail(headers[":method"] ?? "")) {
			stream.respond({ ":status": 500, "content-type": "application/json" });
			stream.end(failure);
			return;
		}
		stream.respond({ ":status": 200 });
		if (headers[":method"] === "POST") {
			stream.on("data", () => stream.write(ackFrame));
		}
	});

	const origin = await listen(server);
	return {
		origin,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				for (const stream of streams) stream.destroy();
				for (const session of sessions) session.destroy();
				server.close(() => resolve());
			}),
	};
}

/**
 * HTTP/1.1 server: fails the first GET and POST with a 500, then holds GETs
 * open as SSE and acks every POST with a JSON AppendAck.
 */
async function startH1Server(): Promise<TestServer> {
	const requests: Captured[] = [];
	const responses = new Set<ServerResponse>();
	const shouldFail = firstAttemptFails();
	const server = http.createServer(
		(req: IncomingMessage, res: ServerResponse) => {
			requests.push({
				method: req.method ?? "",
				path: req.url ?? "",
				header: req.headers[S2_STREAM_CONFIG_HEADER] as string | undefined,
			});
			responses.add(res);
			res.on("close", () => responses.delete(res));
			if (shouldFail(req.method ?? "")) {
				req.on("data", () => {});
				req.on("end", () => {
					res.writeHead(500, { "content-type": "application/json" });
					res.end(failure);
				});
				return;
			}
			if (req.method === "POST") {
				req.on("data", () => {});
				req.on("end", () => {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(
						JSON.stringify({
							start: { seq_num: 0, timestamp: 1 },
							end: { seq_num: 1, timestamp: 1 },
							tail: { seq_num: 1, timestamp: 1 },
						}),
					);
				});
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.flushHeaders();
		},
	);
	const origin = await listen(server);
	return {
		origin,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				for (const res of responses) res.destroy();
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

async function exercise(transport: SessionTransport, server: TestServer) {
	const readSession = await transport.makeReadSession("events", {
		seq_num: 0,
		stream_config: streamConfig,
	});
	const appendSession = await transport.makeAppendSession("events", {
		streamConfig,
	});
	const ticket = await appendSession.submit(
		AppendInput.create([AppendRecord.string({ body: "a" })]),
	);
	await ticket.ack();
	await appendSession.close();
	await waitFor(
		() => server.requests.filter((r) => r.method === "GET").length >= 2,
	);
	await readSession.cancel();

	const reads = server.requests.filter((r) => r.method === "GET");
	const appends = server.requests.filter((r) => r.method === "POST");
	expect(reads.length).toBeGreaterThanOrEqual(2);
	expect(appends.length).toBeGreaterThanOrEqual(2);
	for (const r of reads) {
		expect(r.path).toBe("/v1/streams/events/records?seq_num=0");
	}
	for (const r of [...reads, ...appends]) {
		expect(r.header).toBe(expectedHeader);
	}
}

const retry = { maxAttempts: 3, minBaseDelayMillis: 1, maxBaseDelayMillis: 5 };

describe("s2-stream-config on the wire", () => {
	it(
		"is sent by s2s read and append sessions on connect and reconnect",
		async () => {
			const server = await startH2Server();
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
		"is sent by fetch read and append sessions on connect and reconnect",
		async () => {
			const server = await startH1Server();
			const transport = new FetchTransport({
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
});
