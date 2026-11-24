import { describe, expect, it } from "vitest";
import * as Proto from "../generated/proto/s2.js";
import {
	AppendInput,
	AppendRecord,
	BatchTransform,
	Producer,
	S2,
} from "../index.js";
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
	waitFor,
	withinDeadline,
} from "./helpers.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function protoAckBytes(start: number, end: number): Buffer {
	return Buffer.from(
		Proto.AppendAck.toBinary({
			start: { seqNum: BigInt(start), timestamp: 1n },
			end: { seqNum: BigInt(end), timestamp: 1n },
			tail: { seqNum: BigInt(end), timestamp: 1n },
		}),
	);
}

async function serveProtoAppend(
	cleanup: (fn: () => Promise<unknown>) => void,
	opts?: { holdFirst?: boolean; failFirst?: boolean },
) {
	const bodies: string[] = [];
	const configs: Array<string | string[] | undefined> = [];
	const held: Array<() => void> = [];
	let attempts = 0;

	const server = await serveHttp1((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			attempts++;
			configs.push(req.headers["s2-stream-config"]);
			const decoded = Proto.AppendInput.fromBinary(
				new Uint8Array(Buffer.concat(chunks)),
			);
			for (const r of decoded.records) bodies.push(dec.decode(r.body));

			const reply = () => {
				if (opts?.failFirst && attempts === 1) {
					res.writeHead(503, { "content-type": "application/json" });
					res.end(JSON.stringify({ code: "unavailable", message: "retry" }));
					return;
				}
				res.writeHead(200, { "content-type": "application/protobuf" });
				res.end(
					protoAckBytes(attempts - 1, attempts - 1 + decoded.records.length),
				);
			};
			if (opts?.holdFirst && attempts === 1) {
				held.push(reply);
			} else {
				reply();
			}
		});
	});
	cleanup(server.close);
	return { origin: server.origin, bodies, configs, held };
}

describe("input snapshotting on acceptance (C10)", () => {
	const cleanup = cleanupAfterEach();

	it("snapshots unary append, read, and management inputs (including Buffer and class instances) across retries", async () => {
		const appendBodies: Uint8Array[] = [];
		const appendConfigs: Array<string | string[] | undefined> = [];
		const readQueries: string[] = [];
		const readConfigs: Array<string | string[] | undefined> = [];
		const mgmtBodies: string[] = [];
		const policyBodies: string[] = [];
		const attempts = { append: 0, read: 0, mgmt: 0, policy: 0 };

		const server = await serveHttp1((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				const body = Buffer.concat(chunks);
				const url = req.url ?? "";
				const failOnce = (key: keyof typeof attempts) => {
					if (++attempts[key] !== 1) return false;
					res.writeHead(500, { "content-type": "application/json" });
					res.end(JSON.stringify({ message: "boom" }));
					return true;
				};

				if (req.method === "POST" && url.includes("/records")) {
					appendBodies.push(new Uint8Array(body));
					appendConfigs.push(req.headers["s2-stream-config"]);
					if (failOnce("append")) return;
					res.writeHead(200, { "content-type": "application/protobuf" });
					res.end(protoAckBytes(0, 2));
				} else if (req.method === "GET" && url.includes("/records")) {
					readQueries.push(url);
					readConfigs.push(req.headers["s2-stream-config"]);
					if (failOnce("read")) return;
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ records: [] }));
				} else if (req.method === "PATCH" && url.includes("/basins/")) {
					mgmtBodies.push(body.toString("utf8"));
					if (failOnce("mgmt")) return;
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({}));
				} else if (req.method === "POST" && url.includes("/network-policies")) {
					policyBodies.push(body.toString("utf8"));
					if (failOnce("policy")) return;
					res.writeHead(200, { "content-type": "application/json" });
					res.end(
						JSON.stringify({
							slug: "office",
							id: "office.1",
							created_at: "2026-01-01T00:00:00Z",
							policy: { public_net: { cidrs: ["10.0.0.0/8"] } },
						}),
					);
				} else {
					res.writeHead(404);
					res.end();
				}
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

		const bodyBytes = enc.encode("ORIGINAL");
		const headerVal = enc.encode("ORIG-HDR");
		const nodeBuf = Buffer.from("NODE-BUF");
		const streamConfig: StreamConfig = { retentionPolicy: { ageSecs: 111 } };
		const appendPromise = stream.append({
			records: [
				{
					body: bodyBytes,
					headers: [[enc.encode("k"), headerVal]] as const,
					meteredBytes: 24,
				},
				{ body: nodeBuf, meteredBytes: 16 },
			],
			streamConfig,
			meteredBytes: 40,
		});
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

		const readConfig: StreamConfig = { retentionPolicy: { ageSecs: 222 } };
		const readInput = {
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

		class CustomPublicNet {
			constructor(public cidrs: string[]) {}
		}
		class CustomNetworkPolicy {
			constructor(public publicNet: CustomPublicNet) {}
		}
		const publicNet = new CustomPublicNet(["10.0.0.0/8"]);
		const policyPromise = client.networkPolicies.create({
			slug: "office",
			policy: new CustomNetworkPolicy(publicNet),
		});
		publicNet.cidrs.push("0.0.0.0/0");
		await withinDeadline(policyPromise);
		expect(policyBodies).toHaveLength(2);
		for (const raw of policyBodies) {
			expect(JSON.parse(raw)).toEqual({
				slug: "office",
				policy: { public_net: { cidrs: ["10.0.0.0/8"] } },
			});
		}
	});

	it.each(["s2s", "fetch"] as SessionTransports[])(
		"snapshots Uint8Array bodies and session streamConfig across %s appendSession retries",
		async (transport) => {
			let origin: string;
			let sentBodies: string[];
			let sentConfigs: Array<string | string[] | undefined>;

			if (transport === "s2s") {
				sentBodies = [];
				sentConfigs = [];
				let attempts = 0;
				const server = await serveHttp2((stream, headers) => {
					const attempt = ++attempts;
					sentConfigs.push(headers["s2-stream-config"]);
					const parser = new S2SFrameParser();
					stream.respond({ ":status": 200 });
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
				});
				cleanup(server.close);
				origin = server.origin;
			} else {
				const srv = await serveProtoAppend(cleanup, { failFirst: true });
				origin = srv.origin;
				sentBodies = srv.bodies;
				sentConfigs = srv.configs;
			}

			const stream = new S2({
				accessToken: "token",
				endpoints: { account: origin, basin: origin },
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

	it("snapshots Producer.submit() bodies while lingering and ReadInput streamConfig across readSession reconnect", async () => {
		const appendSrv = await serveProtoAppend(cleanup);
		const appendStream = new S2({
			accessToken: "token",
			endpoints: { account: appendSrv.origin, basin: appendSrv.origin },
		})
			.basin("my-basin-1")
			.stream("events", { forceTransport: "fetch" });
		cleanup(() => withinDeadline(appendStream.close()));

		const producer = new Producer(
			new BatchTransform({ lingerDurationMillis: 25 }),
			await appendStream.appendSession(),
		);
		cleanup(() => withinDeadline(producer.close()).catch(() => {}));

		const body = enc.encode("ORIGINAL");
		const submitPromise = producer.submit({ body, meteredBytes: 16 });
		body.set(enc.encode("MUTATED!"));
		await withinDeadline((await withinDeadline(submitPromise)).ack());
		expect(appendSrv.bodies).toEqual(["ORIGINAL"]);

		const seenConfigs: Array<string | string[] | undefined> = [];
		let readAttempts = 0;
		const readSrv = await serveHttp1((req, res) => {
			readAttempts++;
			seenConfigs.push(req.headers["s2-stream-config"]);
			if (readAttempts === 1) {
				res.writeHead(503, { "content-type": "application/json" });
				res.end(JSON.stringify({ code: "unavailable", message: "retry" }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end('event: batch\ndata: {"records":[]}\n\n');
		});
		cleanup(readSrv.close);

		const readStream = new S2({
			accessToken: "token",
			endpoints: { account: readSrv.origin, basin: readSrv.origin },
			retry: { maxAttempts: 3, minBaseDelayMillis: 5, maxBaseDelayMillis: 10 },
		})
			.basin("my-basin-1")
			.stream("events", { forceTransport: "fetch" });
		cleanup(() => withinDeadline(readStream.close()));

		const cfg: StreamConfig = { retentionPolicy: { ageSecs: 444 } };
		const readInput: ReadInput = {
			start: { from: { seqNum: 0 } },
			streamConfig: cfg,
		};
		const readSessionPromise = readStream.readSession(readInput);
		(cfg.retentionPolicy as { ageSecs: number }).ageSecs = 999;
		for await (const _ of await withinDeadline(readSessionPromise)) {
			// drain
		}
		expect(seenConfigs).toEqual([
			'{"retention_policy":{"age":444}}',
			'{"retention_policy":{"age":444}}',
		]);
	});

	it("snapshots queued writable chunks before sink/transform runs and closes cleanly on copy failure", async () => {
		const sSrv = await serveProtoAppend(cleanup, { holdFirst: true });
		const sStream = new S2({
			accessToken: "token",
			endpoints: { account: sSrv.origin, basin: sSrv.origin },
		})
			.basin("my-basin-1")
			.stream("events", { forceTransport: "fetch" });
		cleanup(() => withinDeadline(sStream.close()));

		const session = await sStream.appendSession({ maxInflightBatches: 1 });
		cleanup(() => withinDeadline(session.close()).catch(() => {}));
		const sWriter = session.writable.getWriter();
		const [s1, s2, s3] = [
			enc.encode("FIRST"),
			enc.encode("SECOND"),
			enc.encode("THIRD"),
		];
		const sw1 = sWriter.write({
			records: [{ body: s1, meteredBytes: 13 }],
			meteredBytes: 13,
		});
		const sw2 = sWriter.write({
			records: [{ body: s2, meteredBytes: 14 }],
			meteredBytes: 14,
		});
		const sw3 = sWriter.write({
			records: [{ body: s3, meteredBytes: 13 }],
			meteredBytes: 13,
		});
		s1.set(enc.encode("XXXXX"));
		s2.set(enc.encode("YYYYYY"));
		s3.set(enc.encode("ZZZZZ"));
		await withinDeadline(sw1);
		await waitFor(() => sSrv.held.length === 1);
		sSrv.held[0]!();
		await withinDeadline(Promise.all([sw2, sw3, sWriter.close()]));
		expect(sSrv.bodies).toEqual(["FIRST", "SECOND", "THIRD"]);

		const batcher = new BatchTransform({
			maxBatchRecords: 1,
			lingerDurationMillis: 0,
		});
		const bWriter = batcher.writable.getWriter();
		const bReader = batcher.readable.getReader();
		const [b1, b2, b3] = [enc.encode("B1"), enc.encode("B2"), enc.encode("B3")];
		const bw = [b1, b2, b3].map((body) =>
			bWriter.write({ body, meteredBytes: 10 }),
		);
		b1.set(enc.encode("XX"));
		b2.set(enc.encode("YY"));
		b3.set(enc.encode("ZZ"));
		const out: string[] = [];
		const bClose = bWriter.close();
		for (;;) {
			const { value, done } = await withinDeadline(bReader.read());
			if (done) break;
			out.push(dec.decode(value.records[0]!.body as Uint8Array));
		}
		await withinDeadline(Promise.all([...bw, bClose]));
		expect(out).toEqual(["B1", "B2", "B3"]);

		const pSrv = await serveProtoAppend(cleanup, { holdFirst: true });
		const pStream = new S2({
			accessToken: "token",
			endpoints: { account: pSrv.origin, basin: pSrv.origin },
		})
			.basin("my-basin-1")
			.stream("events", { forceTransport: "fetch" });
		cleanup(() => withinDeadline(pStream.close()));

		const producer = new Producer(
			new BatchTransform({ maxBatchRecords: 1, lingerDurationMillis: 0 }),
			await pStream.appendSession({ maxInflightBatches: 1 }),
		);
		cleanup(() => withinDeadline(producer.close()).catch(() => {}));
		const pWriter = producer.writable.getWriter();
		const [p1, p2, p3] = [
			enc.encode("P-ONE"),
			enc.encode("P-TWO"),
			enc.encode("P-THR"),
		];
		const pw1 = pWriter.write({ body: p1, meteredBytes: 13 });
		const pw2 = pWriter.write({ body: p2, meteredBytes: 13 });
		const pw3 = pWriter.write({ body: p3, meteredBytes: 13 });
		p1.set(enc.encode("XXXXX"));
		p2.set(enc.encode("YYYYY"));
		p3.set(enc.encode("ZZZZZ"));

		// Detached buffer fails its write copy; flush()/close() must settle instead of hanging.
		const detachedBuf = new ArrayBuffer(4);
		const detachedView = new Uint8Array(detachedBuf);
		structuredClone(detachedBuf, { transfer: [detachedBuf] });
		const pwBad = pWriter.write({ body: detachedView, meteredBytes: 12 });

		await withinDeadline(pw1);
		await waitFor(() => pSrv.held.length === 1);
		pSrv.held[0]!();
		await withinDeadline(Promise.all([pw2, pw3]));
		await expect(withinDeadline(pwBad)).rejects.toThrow(TypeError);
		await withinDeadline(producer.flush());
		await withinDeadline(producer.close());
		expect(pSrv.bodies).toEqual(["P-ONE", "P-TWO", "P-THR"]);
	});
});
