import {
	AppendInput,
	AppendRecord,
	RangeNotSatisfiableError,
	type ReadInput,
	type ReadRecord,
	randomToken,
	S2Error,
	type S2Stream,
} from "@s2-dev/streamstore";
import {
	appendFenceCommand,
	appendTrimCommand,
	createPartAssembler,
	isFenceRecord,
	isTerminalFence,
	isTrimRecord,
	stoppingGenerationStart,
} from "./protocol.js";

export interface TailedStringRecord {
	body: string;
	nextSeqNum: number;
}

export interface SseFrame {
	event?: string;
	data: string;
}

type FencePolicy = "skip" | "stop" | "stop-terminal";

function sseLines(
	record: TailedStringRecord,
	formatter?: (body: string) => SseFrame,
): string {
	if (!formatter) {
		return `id: ${record.nextSeqNum}\ndata: ${record.body}`;
	}
	const frame = formatter(record.body);
	return [
		...(frame.event ? [`event: ${frame.event}`] : []),
		`data: ${frame.data}`,
		`id: ${record.nextSeqNum}`,
	].join("\n");
}

export function tailAsSse(
	source: AsyncIterable<TailedStringRecord>,
	headers: Readonly<Record<string, string>>,
	formatter?: (body: string) => SseFrame,
	cancelRead?: () => void | Promise<void>,
): Response {
	const iterator = source[Symbol.asyncIterator]();
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await iterator.next();
				if (next.done) {
					controller.close();
					return;
				}
				controller.enqueue(
					encoder.encode(`${sseLines(next.value, formatter)}\n\n`),
				);
			} catch (err) {
				controller.error(err);
				await iterator.return?.();
			}
		},
		async cancel() {
			// Generator.return() alone queues behind an idle read's pending next().
			const cancelled = cancelRead?.();
			await Promise.all([cancelled, iterator.return?.()]);
		},
	});
	return new Response(body, { headers });
}

async function* readStringRecords(
	stream: S2Stream,
	input: ReadInput,
	signal?: AbortSignal,
): AsyncIterable<ReadRecord<"string">> {
	signal?.throwIfAborted();
	const session = await stream
		.readSession(input, { as: "string", signal })
		.catch((error: unknown) => {
			if (isMissingStreamError(error)) return null;
			throw error;
		});
	if (!session) return;
	const reader = session.getReader();
	const cancel = () => {
		// Cancel the owned reader even if the transport has not attached its signal yet.
		void reader.cancel(signal?.reason).catch(() => {});
	};
	signal?.addEventListener("abort", cancel, { once: true });
	if (signal?.aborted) cancel();
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) return;
			yield next.value;
		}
	} finally {
		signal?.removeEventListener("abort", cancel);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
		await session[Symbol.asyncDispose]?.();
	}
}

async function* tailDataRecords(
	stream: S2Stream,
	fromSeqNum: number,
	fencePolicy: FencePolicy,
	signal?: AbortSignal,
): AsyncIterable<TailedStringRecord> {
	const records = readStringRecords(
		stream,
		{ start: { from: { seqNum: fromSeqNum } } },
		signal,
	);
	const assemble = createPartAssembler();
	for await (const record of records) {
		if (isFenceRecord(record)) {
			if (stoppingGenerationStart(record.body) !== undefined) continue;
			if (
				fencePolicy === "stop" ||
				(fencePolicy === "stop-terminal" && isTerminalFence(record))
			) {
				break;
			}
			continue;
		}
		if (isTrimRecord(record) || !record.body) continue;
		const body = assemble(record);
		if (body !== undefined) yield { body, nextSeqNum: record.seqNum + 1 };
	}
}

export async function* readAvailableDataRecords(
	stream: S2Stream,
	fromSeqNum: number,
	untilSeqNum = Number.POSITIVE_INFINITY,
	signal?: AbortSignal,
): AsyncIterable<TailedStringRecord> {
	const records = readStringRecords(
		stream,
		{
			start: { from: { seqNum: fromSeqNum }, clamp: true },
			stop: { waitSecs: 0 },
		},
		signal,
	);
	const assemble = createPartAssembler();
	for await (const record of records) {
		if (record.seqNum >= untilSeqNum) break;
		if (isFenceRecord(record) || isTrimRecord(record) || !record.body) {
			continue;
		}
		const body = assemble(record);
		if (body !== undefined) yield { body, nextSeqNum: record.seqNum + 1 };
	}
}

interface SharedStreamState {
	reusableFenceToken: string | null;
	/**
	 * Token of the current holder when there is an active generation. Used
	 * to promote to the reusable slot after the lease expires.
	 */
	heldFenceToken: string | null;
	activeGenerationStartSeqNum: number | null;
	hasActiveGeneration: boolean;
	nextSeqNum: number;
	/**
	 * Unix-ms timestamp of the most recent record of any kind, or null if the
	 * stream is empty. Used as the liveness signal for the lease check: as
	 * long as the generation keeps writing records, the lease keeps sliding
	 * forward.
	 */
	lastRecordTimestamp: number | null;
}

export interface SessionReplayState {
	hasActiveGeneration: boolean;
	activeGenerationStartSeqNum: number | null;
	nextSeqNum: number;
}

function createEmptySharedStreamState(): SharedStreamState {
	return {
		reusableFenceToken: "",
		heldFenceToken: null,
		activeGenerationStartSeqNum: null,
		hasActiveGeneration: false,
		nextSeqNum: 0,
		lastRecordTimestamp: null,
	};
}

export function isMissingStreamError(error: unknown): boolean {
	return (
		error instanceof S2Error &&
		error.status === 404 &&
		(error.code === "stream_not_found" || error.code === undefined)
	);
}

async function readSharedStreamState(
	stream: S2Stream,
): Promise<SharedStreamState> {
	const session = await stream
		.readSession(
			{
				start: { from: { seqNum: 0 }, clamp: true },
				stop: { waitSecs: 0 },
			},
			{ as: "string" },
		)
		.catch((error: unknown) => {
			if (isMissingStreamError(error)) return null;
			throw error;
		});
	if (!session) return createEmptySharedStreamState();

	const state = createEmptySharedStreamState();
	try {
		for await (const record of session) {
			state.nextSeqNum = record.seqNum + 1;
			state.lastRecordTimestamp = record.timestamp.getTime();
			if (!isFenceRecord(record)) {
				continue;
			}
			if (isTerminalFence(record)) {
				state.hasActiveGeneration = false;
				state.reusableFenceToken = record.body;
				continue;
			}
			state.activeGenerationStartSeqNum =
				stoppingGenerationStart(record.body) ?? record.seqNum;
			state.hasActiveGeneration = true;
			state.reusableFenceToken = null;
			state.heldFenceToken = record.body;
		}
	} finally {
		await session[Symbol.asyncDispose]?.();
	}
	return state;
}

export async function claimSharedGeneration({
	stream,
	fencingToken,
	leaseDurationMs,
	now = () => Date.now(),
	trim = true,
}: {
	stream: S2Stream;
	fencingToken: string;
	leaseDurationMs: number;
	/** Time source override for tests. */
	now?: () => number;
	/**
	 * Trim generations older than the previous one after claiming, so slow
	 * readers of the previous generation are not cut off. `false` for session
	 * logs that need to preserve history across generations.
	 *
	 * @default true
	 */
	trim?: boolean;
}): Promise<{
	fromSeqNum: number;
	matchSeqNumStart: number;
} | null> {
	const state = await readSharedStreamState(stream);

	let currentToken = state.reusableFenceToken;
	if (
		currentToken === null &&
		state.heldFenceToken !== null &&
		state.lastRecordTimestamp !== null &&
		now() - state.lastRecordTimestamp >= leaseDurationMs
	) {
		// Active generation hasn't written anything for at least
		// leaseDurationMs, so treat it as abandoned and take it over.
		currentToken = state.heldFenceToken;
	}

	if (currentToken === null) {
		return null;
	}

	const fenceAck = await appendFenceCommand(stream, currentToken, fencingToken);
	let matchSeqNumStart = fenceAck.end.seqNum;

	if (trim && state.activeGenerationStartSeqNum) {
		const trimAck = await appendTrimCommand(
			stream,
			fencingToken,
			state.activeGenerationStartSeqNum,
		);
		matchSeqNumStart = trimAck.end.seqNum;
	}

	return {
		fromSeqNum: fenceAck.start.seqNum,
		matchSeqNumStart,
	};
}

export async function claimSessionGeneration({
	stream,
	fencingToken,
	leaseDurationMs,
}: {
	stream: S2Stream;
	fencingToken: string;
	/** Take over an active generation that hasn't written for this long. */
	leaseDurationMs?: number;
}): Promise<{
	fromSeqNum: number;
	matchSeqNumStart: number;
} | null> {
	const batch = await stream
		.read(
			{
				start: { from: { tailOffset: 1 } },
				stop: { limits: { count: 1 }, waitSecs: 0 },
			},
			{ as: "string" },
		)
		.catch((error: unknown) => {
			if (isMissingStreamError(error)) return null;
			if (error instanceof RangeNotSatisfiableError) return null;
			throw error;
		});
	const lastRecord = batch?.records.at(-1);

	if (!lastRecord) {
		const fenceAck = await appendFenceCommand(stream, "", fencingToken, {
			matchSeqNum: 0,
		});
		return {
			fromSeqNum: fenceAck.start.seqNum,
			matchSeqNumStart: fenceAck.end.seqNum,
		};
	}

	if (!isFenceRecord(lastRecord) || !isTerminalFence(lastRecord)) {
		if (
			leaseDurationMs === undefined ||
			Date.now() - lastRecord.timestamp.getTime() < leaseDurationMs
		) {
			return null;
		}
		// End the abandoned generation so its readers finish, and claim atomically.
		const { fence } = await readLastFence(stream);
		if (!fence?.active) return null;
		const ack = await stream.append(
			AppendInput.create(
				[
					AppendRecord.fence(`error-${randomToken(4)}`),
					AppendRecord.fence(fencingToken),
				],
				{
					fencingToken: fence.body,
					// The fence lookup may observe a writer newer than our stale tail.
					matchSeqNum: lastRecord.seqNum + 1,
				},
			),
		);
		return {
			fromSeqNum: ack.start.seqNum + 1,
			matchSeqNumStart: ack.end.seqNum,
		};
	}

	const fenceAck = await appendFenceCommand(
		stream,
		lastRecord.body,
		fencingToken,
	);
	return {
		fromSeqNum: fenceAck.start.seqNum,
		matchSeqNumStart: fenceAck.end.seqNum,
	};
}

interface LastFence {
	seqNum: number;
	body: string;
	active: boolean;
}

export async function readLastFence(
	stream: S2Stream,
): Promise<{ fence: LastFence | null; nextSeqNum: number }> {
	for (let window = 64; ; window *= 4) {
		const session = await stream
			.readSession(
				{ start: { from: { tailOffset: window } }, stop: { waitSecs: 0 } },
				{ as: "string" },
			)
			.catch((error: unknown) => {
				if (
					isMissingStreamError(error) ||
					error instanceof RangeNotSatisfiableError
				) {
					return null;
				}
				throw error;
			});
		if (!session) return { fence: null, nextSeqNum: 0 };

		let fence: LastFence | null = null;
		let count = 0;
		let nextSeqNum = 0;
		try {
			for await (const record of session) {
				count += 1;
				nextSeqNum = record.seqNum + 1;
				if (isFenceRecord(record)) {
					fence = {
						seqNum: stoppingGenerationStart(record.body) ?? record.seqNum,
						body: record.body,
						active: !isTerminalFence(record),
					};
				}
			}
		} finally {
			await session[Symbol.asyncDispose]?.();
		}
		if (fence || count < window) return { fence, nextSeqNum };
	}
}

export async function* replayActiveGenerationStringRecords(
	stream: S2Stream,
	fromSeqNum = 0,
	signal?: AbortSignal,
): AsyncIterable<TailedStringRecord> {
	const { fence, nextSeqNum } = await readLastFence(stream);
	if (!fence?.active) return;

	yield* tailDataRecords(
		stream,
		Math.max(fence.seqNum, cursorWithin(fromSeqNum, nextSeqNum)),
		"stop-terminal",
		signal,
	);
}

/** A cursor past the tail is from a deleted and recreated stream: start over. */
function cursorWithin(fromSeqNum: number, nextSeqNum: number): number {
	return fromSeqNum > nextSeqNum ? 0 : fromSeqNum;
}

export async function* tailStringRecords(
	stream: S2Stream,
	fromSeqNum = 0,
	signal?: AbortSignal,
): AsyncIterable<TailedStringRecord> {
	const nextSeqNum =
		fromSeqNum > 0
			? await stream.checkTail().then(
					({ tail }) => tail.seqNum,
					(error: unknown) => {
						if (isMissingStreamError(error)) return 0;
						throw error;
					},
				)
			: 0;
	yield* tailDataRecords(
		stream,
		cursorWithin(fromSeqNum, nextSeqNum),
		"skip",
		signal,
	);
}

export async function readSessionReplayState(
	stream: S2Stream,
): Promise<SessionReplayState> {
	const { fence, nextSeqNum } = await readLastFence(stream);
	return {
		hasActiveGeneration: fence?.active ?? false,
		activeGenerationStartSeqNum: fence?.active ? fence.seqNum : null,
		nextSeqNum,
	};
}

export async function* replaySessionStringRecords(
	stream: S2Stream,
	fromSeqNum = 0,
	state?: SessionReplayState,
	signal?: AbortSignal,
): AsyncIterable<TailedStringRecord> {
	const replayState = state ?? (await readSessionReplayState(stream));
	fromSeqNum = cursorWithin(fromSeqNum, replayState.nextSeqNum);
	if (!replayState.hasActiveGeneration) {
		if (fromSeqNum >= replayState.nextSeqNum) return;
		yield* readAvailableDataRecords(stream, fromSeqNum, undefined, signal);
		return;
	}
	const activeStart = replayState.activeGenerationStartSeqNum ?? fromSeqNum;
	if (fromSeqNum < activeStart) {
		yield* readAvailableDataRecords(stream, fromSeqNum, activeStart, signal);
	}
	yield* tailDataRecords(
		stream,
		Math.max(fromSeqNum, activeStart),
		"stop-terminal",
		signal,
	);
}

export async function* tailGenerationStringRecords(
	stream: S2Stream,
	fromSeqNum: number,
	signal?: AbortSignal,
): AsyncIterable<TailedStringRecord> {
	yield* tailDataRecords(stream, fromSeqNum, "stop", signal);
}
