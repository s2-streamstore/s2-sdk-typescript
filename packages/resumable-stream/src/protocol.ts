import {
	type AppendAck,
	AppendInput,
	AppendRecord,
	BatchTransform,
	Producer,
	type ReadRecord,
	S2,
	type S2Stream,
	SeqNumMismatchError,
} from "@s2-dev/streamstore";

export function isFenceRecord(
	record: Pick<ReadRecord<"string">, "headers">,
): boolean {
	return (
		record.headers?.length === 1 &&
		record.headers[0]![0] === "" &&
		record.headers[0]![1] === "fence"
	);
}

export function isTrimRecord(
	record: Pick<ReadRecord<"string">, "headers">,
): boolean {
	return (
		record.headers?.length === 1 &&
		record.headers[0]![0] === "" &&
		record.headers[0]![1] === "trim"
	);
}

export function isTerminalFence(
	record: Pick<ReadRecord<"string">, "body">,
): boolean {
	return Boolean(
		record.body?.startsWith("end-") || record.body?.startsWith("error-"),
	);
}

export async function appendFenceCommand(
	stream: S2Stream,
	currentToken: string | null | undefined,
	newToken: string,
	options?: { matchSeqNum?: number },
): Promise<AppendAck> {
	return await stream.append(
		AppendInput.create([AppendRecord.fence(newToken, Date.now())], {
			fencingToken: currentToken ?? undefined,
			matchSeqNum: options?.matchSeqNum,
		}),
	);
}

export async function appendTrimCommand(
	stream: S2Stream,
	currentToken: string | null | undefined,
	trimBeforeSeqNum: number,
): Promise<AppendAck> {
	return await stream.append(
		AppendInput.create([AppendRecord.trim(trimBeforeSeqNum)], {
			fencingToken: currentToken ?? undefined,
		}),
	);
}

export function createTerminalRecords({
	errorRecord,
	terminalFenceToken,
	trim,
}: {
	errorRecord?: AppendRecord;
	terminalFenceToken: string;
	trim: boolean;
}): AppendRecord[] {
	const records: AppendRecord[] = [];
	if (errorRecord) records.push(errorRecord);
	if (trim) records.push(AppendRecord.trim(Number.MAX_SAFE_INTEGER));
	records.push(AppendRecord.fence(terminalFenceToken));
	return records;
}

export interface PersistToS2Options<T> {
	s2: S2;
	basin: string;
	stream: string;
	source: AsyncIterable<T>;
	fencingToken: string;
	batchSize: number;
	lingerDuration: number;
	toRecord: (value: T) => AppendRecord;
	finalRecords: (sourceError: unknown) => ReadonlyArray<AppendRecord>;
	matchSeqNumStart?: number;
	onSeqNumMismatch?: (error: SeqNumMismatchError) => void;
}

function combineErrors(errors: ReadonlyArray<unknown>): unknown | undefined {
	// Dedupe by identity: a terminal pump error surfaces from multiple phases.
	const failures = [...new Set(errors.filter((error) => error !== undefined))];
	if (failures.length === 0) return undefined;
	if (failures.length === 1) return failures[0];
	return new AggregateError(
		failures,
		"[resumable-stream] Failed to persist and finalize stream.",
	);
}

/**
 * Locate a {@link SeqNumMismatchError} in a persist failure. A mismatch is a
 * terminal pump error, so it surfaces from `producer.close()` and may be
 * combined with distinct errors from other phases (e.g. a source failure) —
 * hence the `AggregateError` case.
 */
function findSeqNumMismatch(failure: unknown): SeqNumMismatchError | undefined {
	if (failure instanceof SeqNumMismatchError) return failure;
	if (failure instanceof AggregateError) {
		for (const error of failure.errors) {
			if (error instanceof SeqNumMismatchError) return error;
		}
	}
	return undefined;
}

export async function persistToS2<T>({
	s2,
	basin,
	stream,
	source,
	fencingToken,
	batchSize,
	lingerDuration,
	toRecord,
	finalRecords,
	matchSeqNumStart,
	onSeqNumMismatch,
}: PersistToS2Options<T>): Promise<void> {
	const handle = s2.basin(basin).stream(stream);
	try {
		const session = await handle.appendSession();
		const transform = new BatchTransform({
			lingerDurationMillis: lingerDuration,
			maxBatchRecords: batchSize,
			fencingToken,
			matchSeqNum: matchSeqNumStart ?? 1,
		});
		const producer = new Producer(transform, session);

		let sourceError: unknown | undefined;
		try {
			for await (const value of source) {
				await producer.submit(toRecord(value));
			}
		} catch (err) {
			sourceError = err;
		}

		let finalizationError: unknown | undefined;
		try {
			for (const record of finalRecords(sourceError)) {
				await producer.submit(record);
			}
		} catch (err) {
			finalizationError = err;
		}

		let closeError: unknown | undefined;
		try {
			await producer.close();
		} catch (err) {
			closeError = err;
		}

		const failure = combineErrors([sourceError, finalizationError, closeError]);
		if (failure !== undefined) {
			// A seq-num mismatch means another writer fenced/advanced this stream;
			// treat it as an expected, handled condition rather than an error.
			const mismatch = findSeqNumMismatch(failure);
			if (mismatch && onSeqNumMismatch) {
				onSeqNumMismatch(mismatch);
				return;
			}
			throw failure;
		}
	} finally {
		await handle.close();
	}
}

export interface StreamReadOptions {
	s2: S2;
	basin: string;
	stream: string;
}

export async function* replayStringBodies({
	s2,
	basin,
	stream,
}: StreamReadOptions): AsyncIterable<string> {
	const handle = s2.basin(basin).stream(stream);
	try {
		const session = await handle.readSession(
			{
				start: { from: { seqNum: 0 } },
			},
			{ as: "string" },
		);
		for await (const record of session) {
			if (isFenceRecord(record)) {
				if (isTerminalFence(record)) break;
				continue;
			}
			if (isTrimRecord(record)) continue;
			if (record.body) {
				yield record.body;
			}
		}
	} finally {
		await handle.close();
	}
}
