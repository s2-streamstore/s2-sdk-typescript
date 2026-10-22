import {
	AppendInput,
	RangeNotSatisfiableError,
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
			await iterator.return?.();
		},
	});
	return new Response(body, { headers });
}

async function openStringReadSession(stream: S2Stream, fromSeqNum: number) {
	return await stream
		.readSession({ start: { from: { seqNum: fromSeqNum } } }, { as: "string" })
		.catch((error: unknown) => {
			if (isMissingStreamError(error)) return null;
			throw error;
		});
}

async function* tailDataRecords(
	stream: S2Stream,
	fromSeqNum: number,
	fencePolicy: FencePolicy,
): AsyncIterable<TailedStringRecord> {
	const session = await openStringReadSession(stream, fromSeqNum);
	if (!session) return;

	const assemble = createPartAssembler();
	try {
		for await (const record of session) {
			if (isFenceRecord(record)) {
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
	} finally {
		await session[Symbol.asyncDispose]?.();
	}
}

async function* readAvailableDataRecords(
	stream: S2Stream,
	fromSeqNum: number,
	untilSeqNum = Number.POSITIVE_INFINITY,
): AsyncIterable<TailedStringRecord> {
	const session = await stream
		.readSession(
			{
				start: { from: { seqNum: fromSeqNum }, clamp: true },
				stop: { waitSecs: 0 },
			},
			{ as: "string" },
		)
		.catch((error: unknown) => {
			if (isMissingStreamError(error)) return null;
			throw error;
		});
	if (!session) return;

	const assemble = createPartAssembler();
	try {
		for await (const record of session) {
			if (record.seqNum >= untilSeqNum) break;
			if (isFenceRecord(record) || isTrimRecord(record) || !record.body) {
				continue;
			}
			const body = assemble(record);
			if (body !== undefined) yield { body, nextSeqNum: record.seqNum + 1 };
		}
	} finally {
		await session[Symbol.asyncDispose]?.();
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
			state.activeGenerationStartSeqNum = record.seqNum;
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
}: {
	stream: S2Stream;
	fencingToken: string;
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
		return null;
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

export interface LastFence {
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
						seqNum: record.seqNum,
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

export async function readActiveFenceToken(
	stream: S2Stream,
): Promise<string | null> {
	const { fence } = await readLastFence(stream);
	return fence?.active ? fence.body : null;
}

export async function* replayActiveGenerationStringRecords(
	stream: S2Stream,
	fromSeqNum = 0,
	fenceTokenPrefix?: string,
): AsyncIterable<TailedStringRecord> {
	const { fence, nextSeqNum } = await readLastFence(stream);
	if (!fence?.active) return;
	if (
		fenceTokenPrefix !== undefined &&
		!fence.body.startsWith(fenceTokenPrefix)
	) {
		return;
	}

	yield* tailDataRecords(
		stream,
		Math.max(fence.seqNum, cursorWithin(fromSeqNum, nextSeqNum)),
		"stop-terminal",
	);
}

/**
 * A cursor past the tail came from an earlier stream with the same name
 * (deleted and recreated), so read the current one from the start.
 */
function cursorWithin(fromSeqNum: number, nextSeqNum: number): number {
	return fromSeqNum > nextSeqNum ? 0 : fromSeqNum;
}

export async function* tailStringRecords(
	stream: S2Stream,
	fromSeqNum = 0,
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
	yield* tailDataRecords(stream, cursorWithin(fromSeqNum, nextSeqNum), "skip");
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
): AsyncIterable<TailedStringRecord> {
	const replayState = state ?? (await readSessionReplayState(stream));
	fromSeqNum = cursorWithin(fromSeqNum, replayState.nextSeqNum);
	if (!replayState.hasActiveGeneration) {
		if (fromSeqNum >= replayState.nextSeqNum) return;
		yield* readAvailableDataRecords(stream, fromSeqNum);
		return;
	}
	const activeStart = replayState.activeGenerationStartSeqNum ?? fromSeqNum;
	if (fromSeqNum < activeStart) {
		yield* readAvailableDataRecords(stream, fromSeqNum, activeStart);
	}
	yield* tailDataRecords(
		stream,
		Math.max(fromSeqNum, activeStart),
		"stop-terminal",
	);
}

export async function* tailGenerationStringRecords(
	stream: S2Stream,
	fromSeqNum: number,
): AsyncIterable<TailedStringRecord> {
	yield* tailDataRecords(stream, fromSeqNum, "stop");
}
