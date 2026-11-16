import { describe, expect, it } from "vitest";
import * as Redacted from "../lib/redacted.js";
import { FetchTransport } from "../lib/stream/transport/fetch/index.js";
import { S2STransport } from "../lib/stream/transport/s2s/index.js";
import type { SessionTransport } from "../lib/stream/types.js";
import { AppendInput, AppendRecord } from "../types.js";
import { serveHttp1, serveHttp2, withinDeadline } from "./helpers.js";

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

/** HTTP/2 server that accepts append streams but never acks. */
async function startH2StallServer(): Promise<StallServer> {
	let appends = 0;
	const server = await serveHttp2((stream) => {
		appends++;
		stream.respond({ ":status": 200 });
		stream.on("data", () => {});
	});
	return { ...server, appends: () => appends };
}

/** HTTP/1.1 server that reads append requests but never responds. */
async function startH1StallServer(): Promise<StallServer> {
	let appends = 0;
	const server = await serveHttp1((req) => {
		appends++;
		req.resume();
	});
	return { ...server, appends: () => appends };
}

// Each attempt is bounded by the request timeout, not by the stalled request.
const DEADLINE_MS = MAX_ATTEMPTS * REQUEST_TIMEOUT_MS + 2_000;

async function exercise(transport: SessionTransport, server: StallServer) {
	const session = await transport.makeAppendSession("events");
	const ticket = await session.submit(
		AppendInput.create([AppendRecord.string({ body: "a" })]),
	);

	await expect(withinDeadline(ticket.ack(), DEADLINE_MS)).rejects.toThrow(
		`Max attempts (${MAX_ATTEMPTS}) exhausted`,
	);
	expect(server.appends()).toBe(MAX_ATTEMPTS);

	await expect(withinDeadline(session.close(), DEADLINE_MS)).rejects.toThrow(
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
