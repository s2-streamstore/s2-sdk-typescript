import http2, {
	type IncomingHttpHeaders,
	type ServerHttp2Session,
	type ServerHttp2Stream,
} from "node:http2";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { S2Error } from "../error.js";
import * as Proto from "../generated/proto/s2.js";
import { toAPIAppendRecord } from "../internal/mappers.js";
import * as Redacted from "../lib/redacted.js";
import { buildProtoAppendInput } from "../lib/stream/transport/proto.js";
import {
	frameMessage,
	S2SFrameParser,
} from "../lib/stream/transport/s2s/framing.js";
import { S2STransport } from "../lib/stream/transport/s2s/index.js";
import { AppendInput, AppendRecord } from "../types.js";
import { sleep } from "./helpers.js";

const TEST_TIMEOUT_MS = 15_000;
const FRACTIONAL_MS = 1_700_000_000_000.5;

describe("proto append encoding of fractional timestamps", () => {
	it("floors a fractional millisecond timestamp like the JSON path", () => {
		const record = AppendRecord.string({ body: "a", timestamp: FRACTIONAL_MS });
		const json = toAPIAppendRecord(record);
		expect(json.timestamp).toBe(1_700_000_000_000);

		const proto = buildProtoAppendInput(AppendInput.create([record]));
		expect(proto.records[0]?.timestamp).toBe(1_700_000_000_000n);
	});

	it("floors a fractional timestamp on bytes records too", () => {
		const record = AppendRecord.bytes({
			body: new Uint8Array([1]),
			timestamp: FRACTIONAL_MS,
		});
		const proto = buildProtoAppendInput(AppendInput.create([record]));
		expect(proto.records[0]?.timestamp).toBe(1_700_000_000_000n);
	});
});

interface TestServer {
	origin: string;
	timestamps: Array<bigint | undefined>;
	close: () => Promise<void>;
}

/** Plaintext HTTP/2 server that decodes every s2s append frame and acks it. */
async function startH2Server(): Promise<TestServer> {
	const server = http2.createServer();
	const sessions = new Set<ServerHttp2Session>();
	const streams = new Set<ServerHttp2Stream>();
	const timestamps: Array<bigint | undefined> = [];
	let next = 0n;

	server.on("sessionError", () => {});
	server.on("session", (session) => {
		sessions.add(session);
		session.on("error", () => {});
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream, headers: IncomingHttpHeaders) => {
		streams.add(stream);
		stream.on("error", () => {});
		stream.on("close", () => streams.delete(stream));
		stream.respond({ ":status": 200 });
		if (headers[":method"] !== "POST") return;
		const parser = new S2SFrameParser();
		stream.on("data", (chunk: Buffer) => {
			parser.push(new Uint8Array(chunk));
			for (
				let frame = parser.parseFrame();
				frame;
				frame = parser.parseFrame()
			) {
				const input = Proto.AppendInput.fromBinary(frame.body);
				for (const record of input.records) timestamps.push(record.timestamp);
				const start = next;
				next += BigInt(input.records.length);
				stream.write(
					Buffer.from(
						frameMessage({
							terminal: false,
							body: Proto.AppendAck.toBinary({
								start: { seqNum: start, timestamp: 1n },
								end: { seqNum: next, timestamp: 1n },
								tail: { seqNum: next, timestamp: 1n },
							}),
						}),
					),
				);
			}
		});
	});

	const origin = await new Promise<string>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve(`http://127.0.0.1:${port}`);
		});
	});
	return {
		origin,
		timestamps,
		close: () =>
			new Promise<void>((resolve) => {
				for (const stream of streams) stream.destroy();
				for (const session of sessions) session.destroy();
				server.close(() => resolve());
			}),
	};
}

const retry = { maxAttempts: 3, minBaseDelayMillis: 1, maxBaseDelayMillis: 5 };

/** Resolves "hung" if the promise does not settle within `ms`. */
function settlesWithin<T>(promise: Promise<T>, ms: number) {
	return Promise.race([
		promise.then(
			() => "settled" as const,
			() => "settled" as const,
		),
		sleep(ms).then(() => "hung" as const),
	]);
}

describe("s2s append session with a fractional timestamp", () => {
	it(
		"acks the record instead of hanging ticket.ack() forever",
		async () => {
			const server = await startH2Server();
			const transport = new S2STransport({
				baseUrl: `${server.origin}/v1`,
				accessToken: Redacted.make("token"),
				retry,
			});
			const session = await transport.makeAppendSession("events");
			try {
				const ticket = await session.submit(
					AppendInput.create([
						AppendRecord.string({ body: "a", timestamp: FRACTIONAL_MS }),
					]),
				);
				const ack = ticket.ack();
				expect(await settlesWithin(ack, 3_000)).toBe("settled");
				await expect(ack).resolves.toMatchObject({ end: { seqNum: 1 } });
				expect(server.timestamps).toEqual([1_700_000_000_000n]);
			} finally {
				await Promise.race([session.close().catch(() => {}), sleep(2_000)]);
				await server.close().catch(() => {});
				await transport.close().catch(() => {});
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"surfaces an encoder failure as a rejected ack instead of a hang",
		async () => {
			const server = await startH2Server();
			const transport = new S2STransport({
				baseUrl: `${server.origin}/v1`,
				accessToken: Redacted.make("token"),
				retry,
			});
			const session = await transport.makeAppendSession("events");
			try {
				// Bypass AppendInput.create() so the proto encoder itself throws
				// (BigInt(0.5) is a RangeError); the transport must still hand the
				// retry layer a result rather than a rejected promise.
				const record = AppendRecord.string({ body: "a" });
				const input: AppendInput = {
					records: [record],
					matchSeqNum: 0.5,
					meteredBytes: record.meteredBytes,
				};
				const ticket = await session.submit(input);
				const ack = ticket.ack();
				expect(await settlesWithin(ack, 3_000)).toBe("settled");
				await expect(ack).rejects.toBeInstanceOf(S2Error);
				expect(server.timestamps).toEqual([]);
			} finally {
				await Promise.race([session.close().catch(() => {}), sleep(2_000)]);
				await server.close().catch(() => {});
				await transport.close().catch(() => {});
			}
		},
		TEST_TIMEOUT_MS,
	);
});
