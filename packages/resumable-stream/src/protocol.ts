import {
	type AppendAck,
	AppendInput,
	AppendRecord,
	BatchTransform,
	Producer,
	type ReadRecord,
	S2,
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
	s2: S2,
	basin: string,
	stream: string,
	currentToken: string | null | undefined,
	newToken: string,
): Promise<AppendAck> {
	const command = AppendInput.create(
		[AppendRecord.fence(newToken, Date.now())],
		{ fencingToken: currentToken ?? undefined },
	);
	return await s2.basin(basin).stream(stream).append(command);
}

export async function appendTrimCommand(
	s2: S2,
	basin: string,
	stream: string,
	currentToken: string | null | undefined,
	trimBeforeSeqNum: number,
): Promise<AppendAck> {
	const command = AppendInput.create([AppendRecord.trim(trimBeforeSeqNum)], {
		fencingToken: currentToken ?? undefined,
	});
	return await s2.basin(basin).stream(stream).append(command);
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
	const failures = errors.filter((error) => error !== undefined);
	if (failures.length === 0) return undefined;
	if (failures.length === 1) return failures[0];
	return new AggregateError(
		failures,
		"[resumable-stream] Failed to persist and finalize stream.",
	);
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
				producer.submit(toRecord(value)).catch((err: unknown) => {
					if (err instanceof SeqNumMismatchError) {
						onSeqNumMismatch?.(err);
					}
				});
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
