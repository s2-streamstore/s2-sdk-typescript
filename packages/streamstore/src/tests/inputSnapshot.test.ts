import { describe, expect, it } from "vitest";
import { BatchTransform } from "../batch-transform.js";
import * as Proto from "../generated/proto/s2.js";
import { AppendInput, AppendRecord, Producer, S2 } from "../index.js";
import {
	frameMessage,
	S2SFrameParser,
} from "../lib/stream/transport/s2s/framing.js";
import type { SessionTransports } from "../lib/stream/types.js";
import type { ReadInput, StreamConfig } from "../types.js";
import {
	cleanupAfterEach,
	s2sAckFrame,
	serveHttp1,
	serveHttp2,
	withinDeadline,
} from "./helpers.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function protoAckBytes(start = 0, end = 1): Buffer {
	return Buffer.from(
		Proto.AppendAck.toBinary({
			start: { seqNum: BigInt(start), timestamp: 1n },
			end: { seqNum: BigInt(end), timestamp: 1n },
			tail: { seqNum: BigInt(end), timestamp: 1n },
		}),
	);
}

describe("input snapshotting on acceptance (C10)", () => {
	const cleanup = cleanupAfterEach();

	it("snapshots Uint8Array/Buffer bodies, headers, streamConfig, ReadInput, and management configs across retries", async () => {
		const appendBodies: Uint8Array[] = [];
		const appendConfigs: Array<string | string[] | undefined> = [];
		const readQueries: string[] = [];
		const readConfigs: Array<string | string[] | undefined> = [];
		const mgmtBodies: string[] = [];

		let appendAttempts = 0;
		let readAttempts = 0;
		let mgmtAttempts = 0;

		const server = await serveHttp1((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				const body = Buffer.concat(chunks);
				const url = req.url ?? "";
				if (req.method === "POST" && url.includes("/records")) {
					appendAttempts++;
					appendBodies.push(new Uint8Array(body));
					appendConfigs.push(req.headers["s2-stream-config"]);
					if (appendAttempts === 1) {
						res.writeHead(500, { "content-type": "application/json" });
						res.end(JSON.stringify({ message: "boom" }));
						return;
					}
					res.writeHead(200, { "content-type": "application/protobuf" });
					res.end(protoAckBytes(0, 2));
					return;
				}
				if (req.method === "GET" && url.includes("/records")) {
					readAttempts++;
					readQueries.push(url);
					readConfigs.push(req.headers["s2-stream-config"]);
					if (readAttempts === 1) {
						res.writeHead(500, { "content-type": "application/json" });
						res.end(JSON.stringify({ message: "boom" }));
						return;
					}
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ records: [] }));
					return;
				}
				if (req.method === "PATCH" && url.includes("/basins/")) {
					mgmtAttempts++;
					mgmtBodies.push(body.toString("utf8"));
					if (mgmtAttempts === 1) {
						res.writeHead(500, { "content-type": "application/json" });
						res.end(JSON.stringify({ message: "boom" }));
						return;
					}
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({}));
					return;
				}
				res.writeHead(404);
				res.end();
			});
		});
		cleanup(server.close);

		const client = new S2({
			accessToken: "token",
			endpoints: { account: server.origin, basin: server.origin },
			retry: { maxAttempts: 3, minBaseDelayMillis: 5, maxBaseDelayMillis: 10 },
		});
		const stream = client
			.basin("my-basin-1")
			.stream("events", { forceTransport: "fetch" });
		cleanup(() => withinDeadline(stream.close()));

		// 1. Unary append: mutate Uint8Array body, header, Buffer body, and streamConfig after calling.
		const bodyBytes = enc.encode("ORIGINAL");
		const headerVal = enc.encode("ORIG-HDR");
		const nodeBuf = Buffer.from("NODE-BUF");
		const streamConfig: StreamConfig = { retentionPolicy: { ageSecs: 111 } };
		const input = {
			records: [
				{
					body: bodyBytes,
					headers: [[enc.encode("k"), headerVal]] as const,
					meteredBytes: 24,
				},
				{
					body: nodeBuf,
					meteredBytes: 16,
				},
			],
			streamConfig,
			meteredBytes: 40,
		};

		const appendPromise = stream.append(input);
		bodyBytes.set(enc.encode("MUTATED!"));
		headerVal.set(enc.encode("MUT-HDR!"));
		nodeBuf.write("MUTATED!");
		(streamConfig.retentionPolicy as { ageSecs: number }).ageSecs = 999;

		await withinDeadline(appendPromise);
		expect(appendBodies).toHaveLength(2);
		for (const raw of appendBodies) {
			const decoded = Proto.AppendInput.fromBinary(raw);
			expect(dec.decode(decoded.records[0]!.body)).toBe("ORIGINAL");
			expect(dec.decode(decoded.records[0]!.headers[0]!.value)).toBe(
				"ORIG-HDR",
			);
			expect(dec.decode(decoded.records[1]!.body)).toBe("NODE-BUF");
		}
		expect(appendConfigs).toEqual([
			'{"retention_policy":{"age":111}}',
			'{"retention_policy":{"age":111}}',
		]);

		// 2. Unary read: mutate ReadInput start and streamConfig after calling.
		const readConfig: StreamConfig = { retentionPolicy: { ageSecs: 222 } };
		const readInput: {
			start: { from: { seqNum: number } };
			streamConfig: StreamConfig;
		} = {
			start: { from: { seqNum: 5 } },
			streamConfig: readConfig,
		};
		const readPromise = stream.read(readInput);
		readInput.start.from.seqNum = 999;
		(readConfig.retentionPolicy as { ageSecs: number }).ageSecs = 888;

		await withinDeadline(readPromise);
		expect(readQueries).toHaveLength(2);
		expect(readQueries.every((q) => q.includes("seq_num=5"))).toBe(true);
		expect(readConfigs).toEqual([
			'{"retention_policy":{"age":222}}',
			'{"retention_policy":{"age":222}}',
		]);

		// 3. Management call: mutate nested config after calling.
		const reconfigInput = {
			basin: "my-basin-1",
			defaultStreamConfig: { retentionPolicy: { ageSecs: 333 } },
		};
		const reconfigPromise = client.basins.reconfigure(reconfigInput);
		reconfigInput.defaultStreamConfig.retentionPolicy.ageSecs = 777;

		await withinDeadline(reconfigPromise);
		expect(mgmtBodies).toHaveLength(2);
		for (const raw of mgmtBodies) {
			expect(JSON.parse(raw)).toMatchObject({
				default_stream_config: { retention_policy: { age: 333 } },
			});
		}
	});

	it.each(["s2s", "fetch"] as SessionTransports[])(
		"snapshots Uint8Array bodies and session streamConfig across %s appendSession retries",
		async (transport) => {
			const sentBodies: string[] = [];
			const sentConfigs: Array<string | string[] | undefined> = [];
			let attempts = 0;

			const server =
				transport === "s2s"
					? await serveHttp2((stream, headers) => {
							const attempt = ++attempts;
							sentConfigs.push(headers["s2-stream-config"]);
							stream.respond({ ":status": 200 });
							const parser = new S2SFrameParser();
							stream.on("data", (chunk: Buffer) => {
								parser.push(chunk);
								for (
									let frame = parser.parseFrame();
									frame;
									frame = parser.parseFrame()
								) {
									const decoded = Proto.AppendInput.fromBinary(frame.body);
									sentBodies.push(dec.decode(decoded.records[0]!.body));
									if (attempt === 1) {
										stream.end(
											Buffer.from(
												frameMessage({
													terminal: true,
													statusCode: 503,
													body: enc.encode(
														JSON.stringify({
															code: "unavailable",
															message: "retry",
														}),
													),
												}),
											),
										);
									} else {
										stream.write(s2sAckFrame(0, 1));
									}
								}
							});
						})
					: await serveHttp1((req, res) => {
							const attempt = ++attempts;
							sentConfigs.push(req.headers["s2-stream-config"]);
							const chunks: Buffer[] = [];
							req.on("data", (c) => chunks.push(c));
							req.on("end", () => {
								const decoded = Proto.AppendInput.fromBinary(
									new Uint8Array(Buffer.concat(chunks)),
								);
								sentBodies.push(dec.decode(decoded.records[0]!.body));
								if (attempt === 1) {
									res.writeHead(503, { "content-type": "application/json" });
									res.end(
										JSON.stringify({ code: "unavailable", message: "retry" }),
									);
								} else {
									res.writeHead(200, {
										"content-type": "application/protobuf",
									});
									res.end(protoAckBytes(0, 1));
								}
							});
						});
			cleanup(server.close);

			const stream = new S2({
				accessToken: "token",
				endpoints: { account: server.origin, basin: server.origin },
				retry: {
					maxAttempts: 3,
					minBaseDelayMillis: 5,
					maxBaseDelayMillis: 10,
				},
			})
				.basin("my-basin-1")
				.stream("events", { forceTransport: transport });
			cleanup(() => withinDeadline(stream.close()));

			const sessionConfig: StreamConfig = { retentionPolicy: { ageSecs: 111 } };
			const sessionPromise = stream.appendSession({
				streamConfig: sessionConfig,
			});
			(sessionConfig.retentionPolicy as { ageSecs: number }).ageSecs = 999;

			const session = await withinDeadline(sessionPromise);
			cleanup(() => withinDeadline(session.close()).catch(() => {}));

			const body = enc.encode("ORIGINAL");
			const input = AppendInput.create([AppendRecord.bytes({ body })]);
			const ticket = await session.submit(input);
			// Mutate both the caller's original buffer and the AppendInput's buffer.
			body.set(enc.encode("MUTATED!"));
			(input.records[0]!.body as Uint8Array).set(enc.encode("MUTATED!"));

			await withinDeadline(ticket.ack());
			expect(sentBodies).toEqual(["ORIGINAL", "ORIGINAL"]);
			expect(sentConfigs).toEqual([
				'{"retention_policy":{"age":111}}',
				'{"retention_policy":{"age":111}}',
			]);
		},
	);

	it("snapshots Uint8Array bodies submitted to Producer while lingering", async () => {
		const sentBodies: string[] = [];
		const server = await serveHttp1((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				const decoded = Proto.AppendInput.fromBinary(
					new Uint8Array(Buffer.concat(chunks)),
				);
				for (const r of decoded.records) {
					sentBodies.push(dec.decode(r.body));
				}
				res.writeHead(200, { "content-type": "application/protobuf" });
				res.end(protoAckBytes(0, decoded.records.length));
			});
		});
		cleanup(server.close);

		const stream = new S2({
			accessToken: "token",
			endpoints: { account: server.origin, basin: server.origin },
		})
			.basin("my-basin-1")
			.stream("events", { forceTransport: "fetch" });
		cleanup(() => withinDeadline(stream.close()));

		const session = await stream.appendSession();
		const producer = new Producer(
			new BatchTransform({ lingerDurationMillis: 25 }),
			session,
		);
		cleanup(() => withinDeadline(producer.close()).catch(() => {}));

		const body = enc.encode("ORIGINAL");
		const record = { body, meteredBytes: 16 };
		const submitPromise = producer.submit(record);
		body.set(enc.encode("MUTATED!"));

		const ticket = await withinDeadline(submitPromise);
		await withinDeadline(ticket.ack());
		expect(sentBodies).toEqual(["ORIGINAL"]);
	});

	it("snapshots ReadInput streamConfig across readSession connect and reconnect", async () => {
		const seenConfigs: Array<string | string[] | undefined> = [];
		let attempts = 0;

		const server = await serveHttp1((req, res) => {
			attempts++;
			seenConfigs.push(req.headers["s2-stream-config"]);
			if (attempts === 1) {
				res.writeHead(503, { "content-type": "application/json" });
				res.end(JSON.stringify({ code: "unavailable", message: "retry" }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end('event: batch\ndata: {"records":[]}\n\n');
		});
		cleanup(server.close);

		const stream = new S2({
			accessToken: "token",
			endpoints: { account: server.origin, basin: server.origin },
			retry: { maxAttempts: 3, minBaseDelayMillis: 5, maxBaseDelayMillis: 10 },
		})
			.basin("my-basin-1")
			.stream("events", { forceTransport: "fetch" });
		cleanup(() => withinDeadline(stream.close()));

		const cfg: StreamConfig = { retentionPolicy: { ageSecs: 444 } };
		const readInput: ReadInput = {
			start: { from: { seqNum: 0 } },
			streamConfig: cfg,
		};
		const sessionPromise = stream.readSession(readInput);
		(cfg.retentionPolicy as { ageSecs: number }).ageSecs = 999;

		const readSession = await withinDeadline(sessionPromise);
		for await (const _ of readSession) {
			// drain
		}
		expect(seenConfigs).toEqual([
			'{"retention_policy":{"age":444}}',
			'{"retention_policy":{"age":444}}',
		]);
	});
});
