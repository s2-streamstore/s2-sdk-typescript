import { describe, expect, it } from "vitest";
import { S2Error, withS2Error } from "../error.js";
import { AppendInput, AppendRecord, S2 } from "../index.js";
import { cleanupAfterEach, serveHttp1, withinDeadline } from "./helpers.js";

describe("withS2Error response parsing", () => {
	it("returns result when response has no error", async () => {
		const value = await withS2Error(async () => ({
			data: { ok: 1 },
			error: undefined,
			response: { status: 200, statusText: "OK" },
		}));

		expect(value).toMatchObject({ data: { ok: 1 }, response: { status: 200 } });
	});

	it("throws S2Error with message/code/status when response.error has message", async () => {
		const run = () =>
			withS2Error(async () => ({
				data: undefined,
				error: { message: "Bad things", code: "BAD_THING" },
				response: { status: 400, statusText: "Bad Request" },
			}));

		await expect(run()).rejects.toMatchObject({
			name: "S2Error",
			message: "Bad things",
			code: "BAD_THING",
			status: 400,
		});
	});

	it("falls back to HTTP statusText when error lacks message", async () => {
		const run = () =>
			withS2Error(async () => ({
				data: undefined,
				error: { something: "else" },
				response: { status: 502, statusText: "Bad Gateway" },
			}));

		await expect(run()).rejects.toMatchObject({
			name: "S2Error",
			message: "Bad Gateway",
			status: 502,
		});
	});

	it("wraps thrown errors as S2Error via s2Error()", async () => {
		const run = () =>
			withS2Error(async () => {
				throw new Error("boom");
			});

		const err = await run().catch((e) => e as S2Error);
		expect(err).toBeInstanceOf(S2Error);
		expect(err.message).toBe("boom");
		// Generic thrown errors get status 0 in s2Error()
		expect(err.status).toBe(0);
	});
});

/**
 * Detail bug_d38cd0d0: malformed HTTP 200 protobuf bodies on unary fetch
 * read/append escaped as raw protobuf-ts exceptions instead of non-retryable
 * S2Error values.
 */
describe("malformed protobuf 200 responses (bug_d38cd0d0)", () => {
	const cleanup = cleanupAfterEach();

	it("surfaces malformed protobuf 200 responses as non-retryable S2Error on read() and append()", async () => {
		let requests = 0;
		const truncatedProto = Buffer.from([0x0a, 0x64]);
		const server = await serveHttp1((req, res) => {
			requests++;
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "content-type": "application/protobuf" });
				res.end(truncatedProto);
			});
		});
		cleanup(server.close);

		const stream = new S2({
			accessToken: "token",
			endpoints: { account: server.origin, basin: server.origin },
			retry: { maxAttempts: 2, minBaseDelayMillis: 1, maxBaseDelayMillis: 5 },
		})
			.basin("test-basin")
			.stream("events", { forceTransport: "fetch" });
		cleanup(() => withinDeadline(stream.close()));

		const readErr = await stream
			.read(undefined, { as: "bytes" })
			.catch((e) => e);
		expect(readErr).toBeInstanceOf(S2Error);
		expect(readErr).toMatchObject({
			origin: "sdk",
			status: 0,
			code: "INVALID_RESPONSE",
		});
		expect(readErr.cause).toBeInstanceOf(Error);
		expect(requests).toBe(1);

		const appendErr = await stream
			.append(
				AppendInput.create([AppendRecord.bytes({ body: new Uint8Array([1]) })]),
			)
			.catch((e) => e);
		expect(appendErr).toBeInstanceOf(S2Error);
		expect(appendErr).toMatchObject({
			origin: "sdk",
			status: 0,
			code: "INVALID_RESPONSE",
		});
		expect(appendErr.cause).toBeInstanceOf(Error);
		expect(requests).toBe(2);
	});
});
