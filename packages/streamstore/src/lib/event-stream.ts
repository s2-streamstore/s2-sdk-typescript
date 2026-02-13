/*
 * Code from Speakeasy (https://speakeasy.com).
 */

import createDebug from "debug";

const debug = createDebug("s2:event-stream");

/** Type for ReadableStream with optional async iterator support. */
type ReadableStreamWithAsyncIterator<T> = ReadableStream<T> & {
	[Symbol.asyncIterator]?: () => AsyncIterableIterator<T>;
};

export type SseMessage<T> = {
	data?: T | undefined;
	event?: string | undefined;
	id?: string | undefined;
	retry?: number | undefined;
};

type ParseResult<T> =
	| {
			done: true;
			value?: undefined;
			batch?: undefined;
	  }
	| {
			done: false;
			batch?: false;
			value?: T;
	  }
	| {
			done: false;
			batch: true;
			value: T[];
	  };

export class EventStream<T>
	extends ReadableStream<T>
	implements AsyncDisposable
{
	constructor(
		responseBody: ReadableStream<Uint8Array>,
		parse: (x: SseMessage<string>) => ParseResult<T>,
	) {
		const upstream = responseBody.getReader();
		let buffer: Uint8Array = new Uint8Array();
		const eventStreamId = Math.random().toString(36).slice(2);
		super({
			async pull(downstream) {
				try {
					while (true) {
						debug("pull loop, eventstream=%s", eventStreamId);
						const match = findBoundary(buffer);
						if (!match) {
							const chunk = await upstream.read();
							if (chunk.done) return downstream.close();
							buffer = concatBuffer(buffer, chunk.value);
							continue;
						}
						const message = buffer.slice(0, match.index);
						buffer = buffer.slice(match.index + match.length);
						const item = parseMessage(message, parse);
						if (item) {
							if (item.batch) {
								for (const chunk of item.value) {
									downstream.enqueue(chunk);
								}
							} else if (item.value) {
								downstream.enqueue(item.value);
							} else if (item.done) {
								await upstream.cancel("done");
								downstream.close();
							}
						}
					}
				} catch (e) {
					downstream.error(e);
					await upstream.cancel(e);
				}
			},
			cancel: (reason) => upstream.cancel(reason),
		});
	}

	async [Symbol.asyncDispose]() {
		await this.cancel("disposed");
	}

	// Polyfill for older browsers
	[Symbol.asyncIterator](): AsyncIterableIterator<T> {
		const proto =
			ReadableStream.prototype as ReadableStreamWithAsyncIterator<T>;
		const fn = proto[Symbol.asyncIterator];
		if (typeof fn === "function") {
			try {
				return fn.call(this);
			} catch {
				// Native method may throw "Illegal invocation" when called on subclass
				// Fall through to manual implementation
			}
		}
		const reader = this.getReader();
		return {
			next: async () => {
				const r = await reader.read();
				if (r.done) {
					reader.releaseLock();
					return { done: true, value: undefined };
				}
				return { done: false, value: r.value };
			},
			throw: async (e) => {
				await reader.cancel(e);
				reader.releaseLock();
				return { done: true, value: undefined };
			},
			return: async () => {
				await reader.cancel("done");
				reader.releaseLock();
				return { done: true, value: undefined };
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		};
	}
}

function concatBuffer(a: Uint8Array, b: Uint8Array): Uint8Array {
	const c = new Uint8Array(a.length + b.length);
	c.set(a, 0);
	c.set(b, a.length);
	return c;
}

/**
 * Finds the first pair of consecutive newline tokens in the buffer.
 * A newline token is CRLF (\r\n), LF (\n), or CR (\r).
 * A boundary is any two consecutive newline tokens, covering all
 * combinations: \r\n\r\n, \r\n\r, \r\n\n, \r\r\n, \r\r, \n\r\n, \n\r, \n\n.
 */
function findBoundary(
	buf: Uint8Array,
): { index: number; length: number } | null {
	const len = buf.length;
	const CR = 13;
	const LF = 10;
	for (let i = 0; i < len; i++) {
		// Detect the first newline token and its length.
		let firstLen: number;
		if (buf[i] === CR && i + 1 < len && buf[i + 1] === LF) {
			firstLen = 2; // CRLF
		} else if (buf[i] === CR) {
			firstLen = 1; // CR
		} else if (buf[i] === LF) {
			firstLen = 1; // LF
		} else {
			continue;
		}
		// Check for a second newline token immediately after the first.
		const j = i + firstLen;
		if (j >= len) return null;
		let secondLen: number;
		if (buf[j] === CR && j + 1 < len && buf[j + 1] === LF) {
			secondLen = 2; // CRLF
		} else if (buf[j] === CR) {
			secondLen = 1; // CR
		} else if (buf[j] === LF) {
			secondLen = 1; // LF
		} else {
			continue;
		}
		return { index: i, length: firstLen + secondLen };
	}
	return null;
}

function parseMessage<T>(
	chunk: Uint8Array,
	parse: (x: SseMessage<string>) => ParseResult<T>,
) {
	const text = new TextDecoder().decode(chunk);
	const lines = text.split(/\r\n|\r|\n/);
	const dataLines: string[] = [];
	const ret: SseMessage<string> = {};
	let ignore = true;
	for (const line of lines) {
		if (!line || line.startsWith(":")) continue;
		ignore = false;
		const i = line.indexOf(":");
		const field = line.slice(0, i);
		const value = line[i + 1] === " " ? line.slice(i + 2) : line.slice(i + 1);
		if (field === "data") dataLines.push(value);
		else if (field === "event") ret.event = value;
		else if (field === "id") ret.id = value;
		else if (field === "retry") {
			const n = Number(value);
			if (!isNaN(n)) ret.retry = n;
		}
	}
	if (ignore) return;
	if (dataLines.length) ret.data = dataLines.join("\n");
	return parse(ret);
}
