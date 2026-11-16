import { afterEach, describe, expect, it } from "vitest";
import * as Proto from "../generated/proto/s2.js";
import * as Redacted from "../lib/redacted.js";
import { decompressFrameBody } from "../lib/stream/transport/s2s/compression.js";
import {
	frameMessage,
	S2SFrameParser,
} from "../lib/stream/transport/s2s/framing.js";
import { S2STransport } from "../lib/stream/transport/s2s/index.js";
import { AppendInput, AppendRecord } from "../types.js";
import { serveHttp2, waitFor, withinDeadline } from "./helpers.js";

const TEST_TIMEOUT_MS = 15_000;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup().catch(() => {});
	}
});

/**
 * An s2s append session on a server that records each record's body, and
 * acks batches in order once it has received `ackAfter` of them.
 */
async function sessionOnServer(ackAfter: number) {
	const bodies: string[] = [];
	const server = await serveHttp2((stream) => {
		stream.respond({ ":status": 200 });
		const parser = new S2SFrameParser();
		const unacked: number[] = [];
		let received = 0;
		let seqNum = 0n;
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
				const start = seqNum;
				seqNum += BigInt(count);
				stream.write(
					frameMessage({
						terminal: false,
						body: Proto.AppendAck.toBinary({
							start: { seqNum: start, timestamp: 1n },
							end: { seqNum, timestamp: 1n },
							tail: { seqNum, timestamp: 1n },
						}),
					}),
				);
			}
		});
		stream.on("end", () => stream.end());
	});
	cleanups.push(server.close);
	const transport = new S2STransport({
		baseUrl: `${server.origin}/v1`,
		accessToken: Redacted.make("token"),
		compression: "gzip",
		// Long enough that a retry cannot stand in for pipelining.
		retry: { requestTimeoutMillis: 10_000 },
	});
	cleanups.push(() => transport.close());
	const session = await transport.makeAppendSession("events");
	cleanups.unshift(() => withinDeadline(session.close()));
	return { session, bodies };
}

const batch = (body: string) =>
	AppendInput.create([AppendRecord.string({ body })]);

describe("s2s append pipelining", () => {
	it(
		"writes batches in the order they were submitted, compressed or not",
		async () => {
			const { session, bodies } = await sessionOnServer(1);
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
			const { session, bodies } = await sessionOnServer(2);

			const first = await session.submit(batch("a"));
			await waitFor(() => bodies.length === 1);
			const second = await session.submit(batch("b"));
			await withinDeadline(Promise.all([first.ack(), second.ack()]));
			expect(bodies).toEqual(["a", "b"]);
		},
		TEST_TIMEOUT_MS,
	);
});
