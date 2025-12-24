import { beforeAll, describe, expect, it } from "vitest";
import { type S2ClientOptions, S2Environment } from "../common.js";
import { AppendRecord, S2 } from "../index.js";
import type { SessionTransports } from "../lib/stream/types.js";

const transports: SessionTransports[] = ["fetch", "s2s"];
const hasEnv = !!process.env.S2_ACCESS_TOKEN && !!process.env.S2_BASIN;
const describeIf = hasEnv ? describe : describe.skip;

describeIf("Mixed format integration tests", () => {
	let s2: S2;
	let basinName: string;
	const createdStreams: string[] = [];
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	const bytesHeader = (label: string): [Uint8Array, Uint8Array] => [
		encoder.encode("x-test-format"),
		encoder.encode(label),
	];

	const decodeHeaderValue = (
		headers: Array<[Uint8Array, Uint8Array]> | undefined,
		name: string,
	): string | undefined => {
		if (!headers) return undefined;
		for (const [rawName, rawValue] of headers) {
			if (decoder.decode(rawName) === name) {
				return decoder.decode(rawValue);
			}
		}
		return undefined;
	};

	beforeAll(() => {
		const basin = process.env.S2_BASIN;
		if (!basin) return;
		const env = S2Environment.parse();
		if (!env.accessToken) return;
		s2 = new S2(env as S2ClientOptions);
		basinName = basin;
	});

	it.each(transports)(
		"supports mixed string/bytes across unary and session APIs (%s)",
		async (transport) => {
			const basin = s2.basin(basinName);
			const streamName = `integration-formats-${transport}-${crypto.randomUUID()}`;
			await basin.streams.create({ stream: streamName });
			createdStreams.push(streamName);
			const stream = basin.stream(streamName, { forceTransport: transport });

			// Append a mixed batch via unary append
			const unaryRecords = [
				AppendRecord.make("unary-string", [["x-test-format", "string-unary"]]),
				AppendRecord.make(encoder.encode("unary-bytes"), [
					bytesHeader("bytes-unary"),
				]),
			];
			await stream.append(unaryRecords);

			// Append another mixed batch via append session
			const sessionRecords = [
				AppendRecord.make("session-string", [
					["x-test-format", "string-session"],
				]),
				AppendRecord.make(encoder.encode("session-bytes"), [
					bytesHeader("bytes-session"),
				]),
			];
			const session = await stream.appendSession();
			await session.submit(sessionRecords);
			await session.close();

			// Unary read as strings
			const readAsString = await stream.read({ seq_num: 0, count: 10 });
			expect(readAsString.records.length).toBe(4);
			const stringRecords = readAsString.records.filter((record) =>
				record.headers?.["x-test-format"]?.startsWith("string"),
			);
			expect(stringRecords.map((record) => record.body)).toEqual(
				expect.arrayContaining(["unary-string", "session-string"]),
			);

			// Unary read as bytes
			const readAsBytes = await stream.read({
				seq_num: 0,
				count: 10,
				as: "bytes",
			});
			expect(readAsBytes.records.length).toBe(4);
			const unaryBytesMap = new Map<string, string>();
			for (const record of readAsBytes.records) {
				const label = decodeHeaderValue(record.headers, "x-test-format");
				if (label && record.body) {
					unaryBytesMap.set(label, decoder.decode(record.body));
				}
			}
			expect(unaryBytesMap.get("string-unary")).toBe("unary-string");
			expect(unaryBytesMap.get("bytes-unary")).toBe("unary-bytes");
			expect(unaryBytesMap.get("string-session")).toBe("session-string");
			expect(unaryBytesMap.get("bytes-session")).toBe("session-bytes");

			// Streaming read session (strings)
			const readSessionStrings = await stream.readSession({
				seq_num: 0,
				count: 4,
			});
			const sessionStringMap = new Map<string, string>();
			let seen = 0;
			for await (const record of readSessionStrings) {
				const label = record.headers?.["x-test-format"];
				if (label?.startsWith("string") && record.body) {
					sessionStringMap.set(label, record.body);
				}
				seen += 1;
				if (seen >= 4) {
					break;
				}
			}
			await readSessionStrings.cancel();
			expect(sessionStringMap.get("string-unary")).toBe("unary-string");
			expect(sessionStringMap.get("string-session")).toBe("session-string");

			// Streaming read session (bytes)
			const readSessionBytes = await stream.readSession({
				seq_num: 0,
				count: 4,
				as: "bytes",
			});
			const sessionBytesMap = new Map<string, string>();
			let bytesSeen = 0;
			for await (const record of readSessionBytes) {
				const label = decodeHeaderValue(record.headers, "x-test-format");
				if (label && record.body) {
					sessionBytesMap.set(label, decoder.decode(record.body));
				}
				bytesSeen += 1;
				if (bytesSeen >= 4) {
					break;
				}
			}
			await readSessionBytes.cancel();
			expect(sessionBytesMap.get("string-unary")).toBe("unary-string");
			expect(sessionBytesMap.get("bytes-unary")).toBe("unary-bytes");
			expect(sessionBytesMap.get("string-session")).toBe("session-string");
			expect(sessionBytesMap.get("bytes-session")).toBe("session-bytes");
		},
	);
});
