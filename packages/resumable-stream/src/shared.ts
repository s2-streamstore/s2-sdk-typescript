import {
	AppendInput,
	AppendRecord,
	RangeNotSatisfiableError,
	randomToken,
	S2Error,
	type S2Stream,
} from "@s2-dev/streamstore";
import {
	appendFenceCommand,
	appendTrimCommand,
	createTerminalRecords,
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
			yield { body: record.body, nextSeqNum: record.seqNum + 1 };
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

	try {
		for await (const record of session) {
			if (record.seqNum >= untilSeqNum) break;
			if (isFenceRecord(record) || isTrimRecord(record) || !record.body) {
				continue;
			}
			yield { body: record.body, nextSeqNum: record.seqNum + 1 };
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
	 * Trim records before the new fence after claiming. `true` for one-shot
	 * generations (`createResumableGeneration` `shared` mode). `false` for
	 * session logs that need to preserve history across generations.
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

	if (trim && state.nextSeqNum > 0) {
		const trimAck = await appendTrimCommand(
			stream,
			fencingToken,
			fenceAck.start.seqNum,
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

export async function stopSharedGeneration({
	stream,
	body,
}: {
	stream: S2Stream;
	body?: string;
}): Promise<boolean> {
	const state = await readSharedStreamState(stream);
	if (!state.hasActiveGeneration || state.heldFenceToken === null) {
		return false;
	}

	const records = [
		...(body ? [AppendRecord.string({ body })] : []),
		...createTerminalRecords({
			terminalFenceToken: `end-${randomToken(4)}`,
			trim: false,
		}),
	];

	await stream.append(
		AppendInput.create(records, { fencingToken: state.heldFenceToken }),
	);
	return true;
}

export async function* replayActiveGenerationStringRecords(
	stream: S2Stream,
	fromSeqNum = 0,
): AsyncIterable<TailedStringRecord> {
	const state = await readSharedStreamState(stream);
	if (state.activeGenerationStartSeqNum === null) return;
	if (!state.hasActiveGeneration) return;

	yield* tailDataRecords(
		stream,
		Math.max(state.activeGenerationStartSeqNum, fromSeqNum),
		"stop-terminal",
	);
}

export async function* tailStringRecords(
	stream: S2Stream,
	fromSeqNum = 0,
): AsyncIterable<TailedStringRecord> {
	yield* tailDataRecords(stream, fromSeqNum, "skip");
}

export async function readSessionReplayState(
	stream: S2Stream,
): Promise<SessionReplayState> {
	const state = await readSharedStreamState(stream);
	return {
		hasActiveGeneration: state.hasActiveGeneration,
		activeGenerationStartSeqNum: state.activeGenerationStartSeqNum,
		nextSeqNum: state.nextSeqNum,
	};
}

export async function* replaySessionStringRecords(
	stream: S2Stream,
	fromSeqNum = 0,
	state?: SessionReplayState,
): AsyncIterable<TailedStringRecord> {
	const replayState = state ?? (await readSessionReplayState(stream));
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

export async function* tailCompactedStringRecords(
	stream: S2Stream,
	compact: (records: TailedStringRecord[]) => TailedStringRecord[],
): AsyncIterable<TailedStringRecord> {
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

	const records: TailedStringRecord[] = [];
	let nextSeqNum = 0;
	if (session) {
		try {
			for await (const record of session) {
				nextSeqNum = Math.max(nextSeqNum, record.seqNum + 1);
				if (isFenceRecord(record) || isTrimRecord(record)) continue;
				if (record.body) {
					records.push({ body: record.body, nextSeqNum: record.seqNum + 1 });
				}
			}
		} finally {
			await session[Symbol.asyncDispose]?.();
		}
	}

	for (const record of compact(records)) {
		yield record;
	}

	yield* tailStringRecords(stream, nextSeqNum);
}
