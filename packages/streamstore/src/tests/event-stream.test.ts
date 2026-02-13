import { describe, expect, it } from "vitest";
import { EventStream, type SseMessage } from "../lib/event-stream.js";

/**
 * Regression tests for SSE boundary detection (issue #118).
 *
 * The findBoundary function is not exported, so we test it indirectly
 * through the EventStream class. We construct a ReadableStream of
 * Uint8Array chunks containing SSE messages separated by various
 * newline pair combinations and verify EventStream correctly splits
 * and parses them.
 */

const encoder = new TextEncoder();

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream({
		pull(controller) {
			if (index < chunks.length) {
				controller.enqueue(chunks[index]!);
				index++;
			} else {
				controller.close();
			}
		},
	});
}

function parseString(
	msg: SseMessage<string>,
): { done: false; value: string } | { done: true } {
	if (msg.event === "done") return { done: true };
	return { done: false, value: msg.data ?? "" };
}

async function collectStream<T>(stream: EventStream<T>): Promise<T[]> {
	const results: T[] = [];
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		results.push(value);
	}
	return results;
}

function buildTwoMessageBuffer(boundary: string): Uint8Array {
	const raw = "data:hello" + boundary + "data:world" + boundary;
	return encoder.encode(raw);
}

describe("EventStream boundary detection (issue #118)", () => {
	const boundaries: { name: string; seq: string; length: number }[] = [
		{ name: "LF+LF", seq: "\n\n", length: 2 },
		{ name: "CR+CR", seq: "\r\r", length: 2 },
		{ name: "LF+CR", seq: "\n\r", length: 2 },
		{ name: "CRLF+CRLF", seq: "\r\n\r\n", length: 4 },
		{ name: "LF+CRLF", seq: "\n\r\n", length: 3 },
		{ name: "CRLF+CR", seq: "\r\n\r", length: 3 },
		{ name: "CRLF+LF", seq: "\r\n\n", length: 3 },
		{ name: "CR+CRLF", seq: "\r\r\n", length: 3 },
	];

	describe("splits two messages with each boundary variant", () => {
		for (const { name, seq } of boundaries) {
			it("splits messages separated by " + name, async () => {
				const buf = buildTwoMessageBuffer(seq);
				const body = streamFromBytes(buf);
				const stream = new EventStream<string>(body, parseString);
				const results = await collectStream(stream);
				expect(results).toEqual(["hello", "world"]);
			});
		}
	});

	describe("splits three messages with each boundary variant", () => {
		for (const { name, seq } of boundaries) {
			it("splits three messages separated by " + name, async () => {
				const raw = "data:one" + seq + "data:two" + seq + "data:three" + seq;
				const buf = encoder.encode(raw);
				const body = streamFromBytes(buf);
				const stream = new EventStream<string>(body, parseString);
				const results = await collectStream(stream);
				expect(results).toEqual(["one", "two", "three"]);
			});
		}
	});

	describe("boundary at different positions in buffer", () => {
		it("detects boundary at the very start of the buffer", async () => {
			const raw = "\n\ndata:first\n\n";
			const buf = encoder.encode(raw);
			const body = streamFromBytes(buf);
			const stream = new EventStream<string>(body, parseString);
			const results = await collectStream(stream);
			expect(results).toEqual(["first"]);
		});

		it("detects boundary at end of buffer after message content", async () => {
			const raw = "data:only\r\n\r\n";
			const buf = encoder.encode(raw);
			const body = streamFromBytes(buf);
			const stream = new EventStream<string>(body, parseString);
			const results = await collectStream(stream);
			expect(results).toEqual(["only"]);
		});

		it("detects boundary with content before and after", async () => {
			const raw = "data:alpha\r\rdata:beta\r\r";
			const buf = encoder.encode(raw);
			const body = streamFromBytes(buf);
			const stream = new EventStream<string>(body, parseString);
			const results = await collectStream(stream);
			expect(results).toEqual(["alpha", "beta"]);
		});
	});

	describe("no false positives on single newlines", () => {
		it("does not split on a single LF within a message", async () => {
			const raw = "data:line1\ndata:line2\n\n";
			const buf = encoder.encode(raw);
			const body = streamFromBytes(buf);
			const stream = new EventStream<string>(body, parseString);
			const results = await collectStream(stream);
			expect(results).toEqual(["line1\nline2"]);
		});

		it("does not split on a single CR within a message", async () => {
			const raw = "data:line1\rdata:line2\r\r";
			const buf = encoder.encode(raw);
			const body = streamFromBytes(buf);
			const stream = new EventStream<string>(body, parseString);
			const results = await collectStream(stream);
			expect(results).toEqual(["line1\nline2"]);
		});

		it("does not split on a single CRLF within a message", async () => {
			const raw = "data:line1\r\ndata:line2\r\n\r\n";
			const buf = encoder.encode(raw);
			const body = streamFromBytes(buf);
			const stream = new EventStream<string>(body, parseString);
			const results = await collectStream(stream);
			expect(results).toEqual(["line1\nline2"]);
		});

		it("text without any newlines produces no output", async () => {
			const raw = "data:incomplete";
			const buf = encoder.encode(raw);
			const body = streamFromBytes(buf);
			const stream = new EventStream<string>(body, parseString);
			const results = await collectStream(stream);
			expect(results).toEqual([]);
		});

		it("single newline at end does not produce a split", async () => {
			const raw = "data:incomplete\n";
			const buf = encoder.encode(raw);
			const body = streamFromBytes(buf);
			const stream = new EventStream<string>(body, parseString);
			const results = await collectStream(stream);
			expect(results).toEqual([]);
		});
	});

	describe("boundary detection across chunk boundaries", () => {
		it("detects boundary split across two chunks", async () => {
			const chunk1 = encoder.encode("data:hello\n");
			const chunk2 = encoder.encode("\ndata:world\n\n");
			const body = streamFromChunks([chunk1, chunk2]);
			const stream = new EventStream<string>(body, parseString);
			const results = await collectStream(stream);
			expect(results).toEqual(["hello", "world"]);
		});

		it("detects CRLF+CRLF boundary split across two chunks", async () => {
			const chunk1 = encoder.encode("data:hello\r\n\r");
			const chunk2 = encoder.encode("\ndata:world\r\n\r\n");
			const body = streamFromChunks([chunk1, chunk2]);
			const stream = new EventStream<string>(body, parseString);
			const results = await collectStream(stream);
			expect(results).toEqual(["hello", "world"]);
		});

		it("handles message data arriving one byte at a time", async () => {
			const full = encoder.encode("data:slow\n\n");
			const chunks: Uint8Array[] = [];
			for (let i = 0; i < full.length; i++) {
				chunks.push(full.slice(i, i + 1));
			}
			const body = streamFromChunks(chunks);
			const stream = new EventStream<string>(body, parseString);
			const results = await collectStream(stream);
			expect(results).toEqual(["slow"]);
		});
	});

	describe("mixed boundary types in a single stream", () => {
		it("handles different boundary types between consecutive messages", async () => {
			const raw = "data:a\n\ndata:b\r\rdata:c\r\n\r\ndata:d\n\r";
			const buf = encoder.encode(raw);
			const body = streamFromBytes(buf);
			const stream = new EventStream<string>(body, parseString);
			const results = await collectStream(stream);
			// \n\r after "data:d" is a valid LF+CR boundary, so "d" is emitted too
			expect(results).toEqual(["a", "b", "c", "d"]);
		});

		it("handles all 8 boundary variants in sequence", async () => {
			const parts = [
				"data:m1\n\n",
				"data:m2\r\r",
				"data:m3\n\r",
				"data:m4\r\n\r\n",
				"data:m5\n\r\n",
				"data:m6\r\n\r",
				"data:m7\r\n\n",
				"data:m8\r\r\n",
			];
			const raw = parts.join("");
			const buf = encoder.encode(raw);
			const body = streamFromBytes(buf);
			const stream = new EventStream<string>(body, parseString);
			const results = await collectStream(stream);
			expect(results).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]);
		});
	});

	describe("SSE fields are parsed correctly with various boundaries", () => {
		it("parses event, id, and data fields with LF+CR boundary", async () => {
			const raw = "event:update\nid:42\ndata:payload\n\r";
			const buf = encoder.encode(raw);
			const body = streamFromBytes(buf);

			const messages: SseMessage<string>[] = [];
			const stream = new EventStream<string>(body, (msg) => {
				messages.push(msg);
				return { done: false, value: msg.data ?? "" };
			});
			const results = await collectStream(stream);
			expect(results).toEqual(["payload"]);
			expect(messages[0]?.event).toBe("update");
			expect(messages[0]?.id).toBe("42");
		});

		it("parses multi-line data with CR+CRLF boundary", async () => {
			const raw = "data:line1\rdata:line2\rdata:line3\r\r\n";
			const buf = encoder.encode(raw);
			const body = streamFromBytes(buf);
			const stream = new EventStream<string>(body, parseString);
			const results = await collectStream(stream);
			expect(results).toEqual(["line1\nline2\nline3"]);
		});
	});
});
