import { describe, expect, it } from "vitest";
import type { RetryConfig } from "../common.js";
import * as Proto from "../generated/proto/s2.js";
import * as Redacted from "../lib/redacted.js";
import { decompressFrameBody } from "../lib/stream/transport/s2s/compression.js";
import { S2SFrameParser } from "../lib/stream/transport/s2s/framing.js";
import { S2STransport } from "../lib/stream/transport/s2s/index.js";
import { AppendInput, AppendRecord } from "../types.js";
import {
	cleanupAfterEach,
	s2sAckFrame,
	serveHttp2,
	sleep,
	waitFor,
	withinDeadline,
} from "./helpers.js";

const TEST_TIMEOUT_MS = 15_000;

const cleanup = cleanupAfterEach();

/**
 * An s2s append session on a server that records each record's body, and
 * acks batches in order once it has received `ackAfter` of them. The first
 * HTTP/2 stream opens `holdFirstStreamMs` late.
 */
async function sessionOnServer({
	ackAfter = 1,
	retry,
	holdFirstStreamMs = 0,
}: {
	ackAfter?: number;
	retry?: RetryConfig;
	holdFirstStreamMs?: number;
} = {}) {
	const bodies: string[] = [];
	const server = await serveHttp2((stream) => {
		stream.respond({ ":status": 200 });
		const parser = new S2SFrameParser();
		const unacked: number[] = [];
		let received = 0;
		let seqNum = 0;
		stream.on("data", (chunk: Buffer) => {
			parser.push(chunk);
			for (
				let frame = parser.parseFrame();
				frame;
				frame = parser.parseFrame()
			) {
				const input = Proto.AppendInput.fromBinary(
					decompressFrameBody(frame.body, frame.compression),
				);
				for (const record of input.records) {
					bodies.push(new TextDecoder().decode(record.body));
				}
				unacked.push(input.records.length);
				received++;
			}
			if (received < ackAfter) return;
			for (const count of unacked.splice(0)) {
				stream.write(s2sAckFrame(seqNum, seqNum + count));
				seqNum += count;
			}
		});
		stream.on("end", () => stream.end());
	});
	cleanup(server.close);
	const transport = new S2STransport({
		baseUrl: `${server.origin}/v1`,
		accessToken: Redacted.make("token"),
		compression: "gzip",
		retry: { requestTimeoutMillis: 10_000, ...retry },
	});
	// Also closes the session.
	cleanup(() => withinDeadline(transport.close()));
	if (holdFirstStreamMs > 0) {
		const internals = transport as unknown as {
			openH2Stream: (headers: unknown) => Promise<unknown>;
		};
		const openH2Stream = internals.openH2Stream.bind(transport);
		internals.openH2Stream = async (headers) => {
			internals.openH2Stream = openH2Stream;
			await sleep(holdFirstStreamMs);
			return openH2Stream(headers);
		};
	}
	const session = await transport.makeAppendSession("events");
	return { session, bodies };
}

const batch = (body: string) =>
	AppendInput.create([AppendRecord.string({ body })]);

describe("s2s append session", () => {
	it(
		"writes batches in the order they were submitted, compressed or not",
		async () => {
			const { session, bodies } = await sessionOnServer();
			const compressed = "a".repeat(2_000);

			const tickets = await Promise.all([
				session.submit(batch(compressed)),
				session.submit(batch("b")),
			]);
			const acks = await withinDeadline(
				Promise.all(tickets.map((ticket) => ticket.ack())),
			);
			expect(bodies).toEqual([compressed, "b"]);
			expect(acks.map((ack) => ack.start.seqNum)).toEqual([0, 1]);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"sends a batch submitted while another awaits its ack",
		async () => {
			// A retry after the default timeout cannot stand in for pipelining.
			const { session, bodies } = await sessionOnServer({ ackAfter: 2 });

			const first = await session.submit(batch("a"));
			await waitFor(() => bodies.length === 1);
			const second = await session.submit(batch("b"));
			await withinDeadline(Promise.all([first.ack(), second.ack()]));
			expect(bodies).toEqual(["a", "b"]);
		},
		TEST_TIMEOUT_MS,
	);

	/**
	 * Issue #364: when an attempt timed out while its HTTP/2 stream was still
	 * opening, the retry layer resent the batch on a new session, but the old
	 * one wrote it too once its stream opened.
	 */
	it(
		"does not write a batch whose attempt timed out before its stream opened",
		async () => {
			const { session, bodies } = await sessionOnServer({
				holdFirstStreamMs: 600,
				retry: {
					requestTimeoutMillis: 200,
					minBaseDelayMillis: 500,
					maxBaseDelayMillis: 500,
					appendRetryPolicy: "noSideEffects",
				},
			});

			const ticket = await session.submit(batch("a"));
			await withinDeadline(ticket.ack(), 5_000);
			expect(bodies).toEqual(["a"]);
		},
		TEST_TIMEOUT_MS,
	);

	/**
	 * Detail bug_499af59d: when an s2s append attempt fails and clears its
	 * pending acks while the server leaves the HTTP/2 stream open, recover()
	 * must reset the abandoned stream (`cancel: true`) instead of half-closing
	 * it, so transport.close() does not hang waiting for the stalled server.
	 */
	it(
		"resets a failed HTTP/2 append stream during retry recovery so close settles",
		async () => {
			let attempts = 0;
			const server = await serveHttp2((stream) => {
				attempts++;
				if (attempts === 1) {
					// Send a retryable HTTP error without ending the response stream
					// (stalled server): S2SAppendSession.safeError() clears pendingAcks
					// while leaving the HTTP/2 stream open.
					stream.respond({ ":status": 503 });
					stream.write(
						JSON.stringify({ code: "unavailable", message: "try again" }),
					);
					return;
				}
				stream.respond({ ":status": 200 });
				stream.on("data", () => stream.write(s2sAckFrame(0, 1)));
				stream.on("end", () => stream.end());
			});
			cleanup(server.close);

			const transport = new S2STransport({
				baseUrl: `${server.origin}/v1`,
				accessToken: Redacted.make("token"),
				retry: {
					maxAttempts: 2,
					minBaseDelayMillis: 1,
					maxBaseDelayMillis: 5,
					requestTimeoutMillis: 10_000,
				},
			});
			cleanup(() => withinDeadline(transport.close()));

			const session = await transport.makeAppendSession("events");
			const ticket = await session.submit(batch("a"));
			await withinDeadline(ticket.ack(), 5_000);
			expect(attempts).toBe(2);

			await withinDeadline(transport.close());
			expect(server.open()).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);
});
