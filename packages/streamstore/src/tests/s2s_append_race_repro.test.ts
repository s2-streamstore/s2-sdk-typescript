/**
 * Regression coverage for the duplicate-append race in the S2S append
 * transport + `RetryAppendSession` retry layer.
 *
 * Bug (introduced in c98fb571): when the per-attempt ack timeout fires while
 * `S2SAppendSession.submit()` is still parked on `await this.initPromise`
 * (lazy HTTP/2 stream setup), the retry layer correctly observes
 * `effectSignalled() === false` and decides to recover. But the parked
 * `submit()` continuation is never cancelled. When `initPromise` later
 * resolves (the connection eventually succeeds) that orphaned continuation
 * runs `sendBatch()`, which previously did NOT consult `this.closed`, so it
 * wrote the batch to a session recovery had already decided to abandon. The
 * retry layer then resubmitted the same input on a fresh session — the server
 * appended the batch twice (S2 has no dedup for non-idempotent appends).
 *
 * Two changes close the race:
 *  - Fix #1 (`s2s/index.ts`): `sendBatch()` refuses to write after `close()`
 *    has set `this.closed`. close() sets the flag synchronously before
 *    awaiting `initPromise`, so this guard fires for any `submit()` that
 *    resumes after close() has begun.
 *  - Fix #2 (`retry.ts`): `recover()` starts `this.session.close()` BEFORE
 *    the backoff sleep, so `this.closed` is set throughout the backoff
 *    window and Fix #1's guard suppresses any orphaned write whose
 *    `initPromise` resolves during the sleep.
 *
 * The tests below drive the REAL `S2SAppendSession` (transport level) and
 * the REAL `RetryAppendSession` (end-to-end) so they exercise the actual fix
 * code, not a model of it.
 */

import type { ClientHttp2Stream } from "node:http2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { S2Error } from "../error.js";
import * as Proto from "../generated/proto/s2.js";
import { AppendInput, AppendRecord } from "../index.js";
import { AdvisedReconnects } from "../lib/reconnect.js";
import * as Redacted from "../lib/redacted.js";
import type { AppendResult, CloseResult } from "../lib/result.js";
import { err, ok, okClose } from "../lib/result.js";
import { RetryAppendSession } from "../lib/retry.js";
import type { CompressionType } from "../lib/stream/transport/s2s/framing.js";
import { frameMessage } from "../lib/stream/transport/s2s/framing.js";
import { S2SAppendSession } from "../lib/stream/transport/s2s/index.js";
import type { TransportAppendSession } from "../lib/stream/types.js";
import type { AppendAck, StreamPosition } from "../types.js";

/**
 * Build a minimal fake HTTP/2 stream that records writes and emits a valid
 * AppendAck frame back through the registered "data" listener so the real
 * `S2SAppendSession` (which parses acks FIFO) can resolve its pending ack.
 */
interface FakeH2Stream {
	closed: boolean;
	writableEnded: boolean;
	writes: Uint8Array[];
	on: (event: string, handler: (...args: unknown[]) => void) => void;
	emit: (event: string, ...args: unknown[]) => void;
	write: (frame: Uint8Array, cb?: (e?: Error) => void) => boolean;
	end: () => void;
	close: () => void;
}

function makeAppendAckFrame(): Uint8Array {
	const ack = Proto.AppendAck.create({
		start: { seqNum: 0n, timestamp: 0n },
		end: { seqNum: 1n, timestamp: 0n },
		tail: { seqNum: 1n, timestamp: 0n },
	});
	return frameMessage({
		terminal: false,
		compression: "none",
		body: Proto.AppendAck.toBinary(ack),
	});
}

function makeFakeH2Stream(): FakeH2Stream {
	const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
	const ackFrame = makeAppendAckFrame();
	const stream: FakeH2Stream = {
		closed: false,
		writableEnded: false,
		writes: [],
		on(event, handler) {
			(handlers[event] ??= []).push(handler);
		},
		emit(event, ...args) {
			for (const h of handlers[event] ?? []) h(...args);
		},
		write(frame, cb) {
			stream.writes.push(frame);
			if (cb) cb();
			// Mirror a healthy server: respond 200, then send the ack frame so
			// the real session's pendingAck can resolve (FIFO).
			queueMicrotask(() => {
				stream.emit("response", { ":status": 200 });
				stream.emit("data", ackFrame);
			});
			return true;
		},
		end() {
			stream.writableEnded = true;
			stream.closed = true;
			stream.emit("close");
		},
		close() {
			stream.closed = true;
			stream.emit("close");
		},
	};
	return stream;
}

/** Build a real S2SAppendSession wired to a fake openH2Stream. */
function makeSession(
	openH2Stream: (headers: unknown) => Promise<{
		stream: ClientHttp2Stream;
		poison: () => void;
	}>,
): Promise<S2SAppendSession> {
	return S2SAppendSession.create(
		"https://example.test/v1",
		Redacted.make("test-token"),
		"test-stream",
		openH2Stream as unknown as Parameters<typeof S2SAppendSession.create>[3],
		undefined,
		undefined,
		"none" as CompressionType,
		new AdvisedReconnects(),
		undefined,
		undefined,
	);
}

const input = AppendInput.create([AppendRecord.string({ body: "event" })]);

describe("S2SAppendSession race: sendBatch must not write after close() (Fix #1)", () => {
	// Transport-level tests use real timers — the race is driven entirely by
	// microtask ordering of a deferred init, not wall-clock scheduling.
	afterEach(() => {
		vi.useRealTimers();
	});

	it("Case B: suppresses the orphaned write when close() set this.closed before init resolved", async () => {
		let resolveOpen: (value: {
			stream: ClientHttp2Stream;
			poison: () => void;
		}) => void;
		const openP = new Promise<{
			stream: ClientHttp2Stream;
			poison: () => void;
		}>((resolve) => {
			resolveOpen = resolve;
		});
		const fakeH2 = makeFakeH2Stream();
		const session = await makeSession(() => openP);

		// submit() parks on await initPromise. submitP is pending.
		const submitP = session.submit(input);

		// close() sets this.closed = true synchronously, then awaits the
		// same pending initPromise.
		const closeP = session.close();

		// Now the connection succeeds — initPromise resolves. submit()'s
		// continuation (registered first, FIFO) runs before close()'s.
		resolveOpen!({
			stream: fakeH2 as unknown as ClientHttp2Stream,
			poison: () => {},
		});

		const [submitResult, closeResult] = await Promise.all([submitP, closeP]);

		// Fix #1: sendBatch saw this.closed === true and refused to write.
		expect(fakeH2.writes).toHaveLength(0);
		expect(submitResult.ok).toBe(false);
		if (!submitResult.ok) {
			expect(submitResult.error.status).toBe(400);
			expect(submitResult.error.message).toContain("closed");
		}
		expect(closeResult.ok).toBe(true);
	});

	it("happy path still writes when the session is open (Fix #1 does not over-suppress)", async () => {
		const fakeH2 = makeFakeH2Stream();
		const session = await makeSession(async () => ({
			stream: fakeH2 as unknown as ClientHttp2Stream,
			poison: () => {},
		}));

		const submitP = session.submit(input);
		const submitResult = await submitP;
		await session.close();

		// The legitimate write happened and the ack resolved successfully.
		expect(fakeH2.writes).toHaveLength(1);
		expect(submitResult.ok).toBe(true);
		if (submitResult.ok) {
			expect(submitResult.value.end.seqNum).toBe(1);
		}
	});
});

/**
 * Fake transport session that reproduces the S2SAppendSession race pattern:
 * submit() parks on a deferred `initPromise` (lazy HTTP/2 stream setup),
 * then — modeling Fix #1's sendBatch guard — re-checks `this.closed` before
 * writing. close() sets `this.closed = true` synchronously before awaiting
 * init, exactly like the real S2SAppendSession.
 */
class LazyInitTransportSession implements TransportAppendSession {
	readonly writes: AppendInput[] = [];
	closed = false;
	private _effectSignalled = false;
	private initPromise?: Promise<void>;
	private initStarted = false;

	constructor(
		private readonly behavior: {
			/** Milliseconds (fake-clock) after submit() before initPromise resolves. */
			initDelayMs: number;
			/** If true, submit() never resolves after init (triggers request timeout). */
			neverAck?: boolean;
			/** If set, submit() resolves ok(ack) this many ms after init resolves. */
			ackDelayMs?: number;
		},
	) {}

	effectSignalled(): boolean {
		return this._effectSignalled;
	}

	async submit(batch: AppendInput): Promise<AppendResult> {
		// Mirror S2SAppendSession.submit: closed guard, lazy init, await,
		// then sendBatch (which has its own closed guard — Fix #1).
		if (this.closed) {
			return err(
				new S2Error({ message: "AppendSession is closed", status: 400 }),
			);
		}
		if (!this.initStarted) {
			this.initStarted = true;
			this.initPromise = new Promise<void>((resolve) => {
				setTimeout(resolve, this.behavior.initDelayMs);
			});
		}
		try {
			await this.initPromise;
		} catch {
			return err(new S2Error({ message: "init failed", status: 502 }));
		}
		// Fix #1 sendBatch guard modeled here.
		if (this.closed) {
			return err(
				new S2Error({ message: "AppendSession is closed", status: 400 }),
			);
		}
		this.writes.push(batch);
		this._effectSignalled = true;

		if (this.behavior.neverAck) {
			return new Promise<AppendResult>(() => {});
		}
		const ackDelay = this.behavior.ackDelayMs ?? 0;
		const start: StreamPosition = { seqNum: 0, timestamp: new Date(0) };
		const end: StreamPosition = { seqNum: 1, timestamp: new Date(0) };
		const tail: StreamPosition = { seqNum: 1, timestamp: new Date(0) };
		const ack: AppendAck = { start, end, tail };
		if (ackDelay > 0) {
			return new Promise<AppendResult>((resolve) => {
				setTimeout(() => {
					this._effectSignalled = false;
					resolve(ok(ack));
				}, ackDelay);
			});
		}
		this._effectSignalled = false;
		return ok(ack);
	}

	async close(): Promise<CloseResult> {
		// Mirror S2SAppendSession.close: set this.closed synchronously first.
		this.closed = true;
		if (this.initPromise) {
			await this.initPromise.catch(() => {});
		}
		return okClose();
	}
}

/** Advance fake time in steps until `waitFor` returns true or budget runs out. */
async function driveTimersUntil(
	waitFor: () => boolean,
	maxMs: number,
	stepMs = 5,
): Promise<boolean> {
	for (let elapsed = 0; elapsed < maxMs; elapsed += stepMs) {
		if (waitFor()) return true;
		await vi.advanceTimersByTimeAsync(stepMs);
		await Promise.resolve();
	}
	return waitFor();
}

/**
 * End-to-end config that triggers the race: requestTimeout (50ms) fires while
 * submit() is parked on lazy init (init resolves at 80ms); backoff (150ms)
 * straddles the init resolution. The third session connects fast (init at
 * 20ms) and acks (10ms), so the operation completes on attempt 3.
 */
const RACE_CONFIG = {
	maxAttempts: 3,
	minBaseDelayMillis: 150,
	maxBaseDelayMillis: 150,
	requestTimeoutMillis: 50,
};

function makeRaceGenerator() {
	const sessions: LazyInitTransportSession[] = [];
	let call = 0;
	const generator = async (): Promise<TransportAppendSession> => {
		call++;
		let s: LazyInitTransportSession;
		if (call === 1 || call === 2) {
			// Init resolves at 80ms (after the 50ms request timeout), during
			// backoff; never acks so the attempt times out.
			s = new LazyInitTransportSession({ initDelayMs: 80, neverAck: true });
		} else {
			// Init resolves fast (20ms) and acks (10ms) before the 50ms timeout.
			s = new LazyInitTransportSession({ initDelayMs: 20, ackDelayMs: 10 });
		}
		sessions.push(s);
		return s;
	};
	return { generator, sessions };
}

describe("RetryAppendSession race: recover() closes before backoff (Fix #2)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("noSideEffects: orphaned submit() parked on lazy init does not duplicate the append", async () => {
		const { generator, sessions } = makeRaceGenerator();
		const session = await RetryAppendSession.create(
			generator,
			undefined,
			{ ...RACE_CONFIG, appendRetryPolicy: "noSideEffects" },
			"test-stream",
		);

		const ticket = await session.submit(input);

		// Track settlement of the ack so we stop advancing as soon as it lands.
		let settled = false;
		let ackErr: unknown;
		ticket
			.ack()
			.then(() => {
				settled = true;
			})
			.catch((e) => {
				ackErr = e;
				settled = true;
			});

		const done = await driveTimersUntil(() => settled, 2000, 5);
		expect(done).toBe(true);
		expect(ackErr).toBeUndefined();

		// Exactly one transport-level write of `input`, on the third (final)
		// session. The two timed-out sessions wrote nothing because
		// recover() closed them before backoff (Fix #2) and sendBatch
		// refused to write after close (Fix #1).
		const writes = sessions.flatMap((s) => s.writes);
		expect(writes).toHaveLength(1);
		expect(writes[0]).toBe(input);

		// The two failed sessions had their orphaned continuations suppressed.
		expect(sessions[0]!.writes).toHaveLength(0);
		expect(sessions[1]!.writes).toHaveLength(0);
		expect(sessions[2]!.writes).toHaveLength(1);

		await session.close();
	});

	it("default 'all' policy: the same race produces no duplicate", async () => {
		const { generator, sessions } = makeRaceGenerator();
		const session = await RetryAppendSession.create(
			generator,
			undefined,
			{ ...RACE_CONFIG, appendRetryPolicy: "all" },
			"test-stream",
		);

		const ticket = await session.submit(input);

		let settled = false;
		let ackErr: unknown;
		ticket
			.ack()
			.then(() => {
				settled = true;
			})
			.catch((e) => {
				ackErr = e;
				settled = true;
			});

		const done = await driveTimersUntil(() => settled, 2000, 5);
		expect(done).toBe(true);
		expect(ackErr).toBeUndefined();

		const writes = sessions.flatMap((s) => s.writes);
		expect(writes).toHaveLength(1);
		expect(writes[0]).toBe(input);

		await session.close();
	});
});
