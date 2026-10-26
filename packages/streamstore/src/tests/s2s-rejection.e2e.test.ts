import { beforeAll, describe, expect, it } from "vitest";
import { type S2ClientOptions, S2Environment } from "../common.js";
import { AppendInput, AppendRecord, S2 } from "../index.js";
import { DEFAULT_RETRY_CONFIG } from "../lib/retry.js";
import type { SessionTransports } from "../lib/stream/types.js";

const hasEnv = !!process.env.S2_ACCESS_TOKEN && !!process.env.S2_BASIN;
const describeIf = hasEnv ? describe : describe.skip;

/**
 * E1: Real s2s transport rejection path.
 *
 * Hand-build an AppendInput literal whose `meteredBytes` lies below the
 * transport's 1 MiB defensive check, but whose actual proto-encoded body
 * exceeds the 2 MiB s2s frame limit. frameMessage() then throws
 * `Message too large` from within sendBatch, surfacing as a rejected
 * submit() promise (not an err(...) result). Before the fix, the
 * RetryAppendSession pump dies silently and ticket.ack() hangs forever;
 * after the fix, the rejection becomes an err() result and aborts the
 * session, surfacing the error to ticket.ack(), failureCause(), and
 * close().
 */
describeIf("RetryAppendSession survives real s2s transport rejections", () => {
	let s2: S2;
	let basinName: string;
	let streamName: string;

	beforeAll(() => {
		const basin = process.env.S2_BASIN;
		if (!basin) return;
		const env = S2Environment.parse();
		env.retry = DEFAULT_RETRY_CONFIG;
		env.retry.appendRetryPolicy = "all";
		env.retry.maxAttempts = 1;
		env.retry.requestTimeoutMillis = 5000;
		if (!env.accessToken) return;
		s2 = new S2(env as S2ClientOptions);
		basinName = basin;
	});

	beforeAll(async () => {
		const timestamp = Date.now();
		streamName = `e1-oversized-frame-${timestamp}`;
		const basin = s2.basin(basinName);
		await basin.streams.create({ stream: streamName });
	});

	it("RetryAppendSession surfaces s2s oversized-frame rejection via abort", async () => {
		const basin = s2.basin(basinName);
		const stream = basin.stream(streamName, { forceTransport: "s2s" });

		const session = await stream.appendSession();

		const oversized = new Uint8Array(3 * 1024 * 1024);
		oversized.fill(0xab);
		const lyingInput: AppendInput = {
			records: [AppendRecord.bytes({ body: oversized })],
			meteredBytes: 100,
		};

		const ticket = await session.submit(lyingInput);
		// Before the fix this hangs forever; after the fix it rejects
		// with an S2Error wrapping "Message too large". The "Message too
		// large" message originates from frameMessage() in the s2s
		// transport's sendBatch, surfacing as a rejected submit() promise
		// (per the bug report: the transport contract is violated). The
		// fix converts that rejection into an err() result that aborts
		// the session, so the message re-surfaces here via abort().
		await expect(ticket.ack()).rejects.toMatchObject({
			message: expect.stringContaining("Message too large"),
		});
		expect(session.failureCause()).toMatchObject({
			message: expect.stringContaining("Message too large"),
		});

		// close() must surface the fatal error, not resolve as if flushed.
		await expect(session.close()).rejects.toMatchObject({
			message: expect.stringContaining("Message too large"),
		});
	}, 30000);

	it("subsequent submit() fails fast after s2s rejection-driven abort", async () => {
		const basin = s2.basin(basinName);
		const stream = basin.stream(streamName, { forceTransport: "s2s" });

		const session = await stream.appendSession();

		const oversized = new Uint8Array(3 * 1024 * 1024);
		oversized.fill(0xab);
		const lyingInput: AppendInput = {
			records: [AppendRecord.bytes({ body: oversized })],
			meteredBytes: 100,
		};

		const ticket = await session.submit(lyingInput);
		await ticket.ack().catch(() => {});

		// A later submit() rejects immediately via the fatalError guard,
		// instead of producing a ticket whose ack() hangs.
		const small = AppendInput.create([AppendRecord.string({ body: "y" })]);
		await expect(session.submit(small)).rejects.toMatchObject({
			message: expect.stringContaining("Message too large"),
		});
		await session.close().catch(() => {});
	}, 30000);
});
