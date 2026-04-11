import {
	type AppendAck,
	AppendInput,
	AppendRecord,
	BatchTransform,
	Producer,
	type ReadRecord,
	S2,
	S2Error,
	SeqNumMismatchError,
} from "@s2-dev/streamstore";

interface StreamGenerationState {
	reusableFenceToken: string | null;
	latestStartSeqNum: number | null;
	latestGenerationActive: boolean;
	nextSeqNum: number;
}

function emptyGenerationState(): StreamGenerationState {
	return {
		reusableFenceToken: "",
		latestStartSeqNum: null,
		latestGenerationActive: false,
		nextSeqNum: 0,
	};
}

function isMissingStreamError(error: unknown): boolean {
	return (
		error instanceof S2Error &&
		error.status === 404 &&
		(error.code === "stream_not_found" || error.code === undefined)
	);
}

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

export async function appendFenceRecord(
	s2: S2,
	basin: string,
	stream: string,
	currentToken: string | null | undefined,
	newToken: string,
): Promise<AppendAck> {
	const record = AppendInput.create([AppendRecord.fence(newToken)], {
		fencingToken: currentToken ?? undefined,
	});
	return await s2.basin(basin).stream(stream).append(record);
}

export async function appendTrimRecord(
	s2: S2,
	basin: string,
	stream: string,
	currentToken: string | null | undefined,
	trimBeforeSeqNum: number,
): Promise<AppendAck> {
	const record = AppendInput.create([AppendRecord.trim(trimBeforeSeqNum)], {
		fencingToken: currentToken ?? undefined,
	});
	return await s2.basin(basin).stream(stream).append(record);
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
	terminalFenceBody: (failed: boolean) => string;
	matchSeqNumStart?: number;
	onSeqNumMismatch?: (error: SeqNumMismatchError) => void;
	onFailureBeforeFence?: () => Promise<void> | void;
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
	terminalFenceBody,
	matchSeqNumStart,
	onSeqNumMismatch,
	onFailureBeforeFence,
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

		let sourceError: unknown;
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

		let closeError: unknown;
		try {
			await producer.close();
		} catch (err) {
			closeError = err;
		}

		const failed = sourceError ?? closeError;
		if (failed) {
			try {
				await onFailureBeforeFence?.();
			} catch {
				// best-effort
			}
		}

		try {
			await appendFenceRecord(
				s2,
				basin,
				stream,
				fencingToken,
				terminalFenceBody(Boolean(failed)),
			);
		} catch {
			// best-effort
		}

		if (failed) throw failed;
	} finally {
		await handle.close();
	}
}

export interface ReplayStringBodiesOptions {
	s2: S2;
	basin: string;
	stream: string;
}

async function inspectStreamGenerationState({
	s2,
	basin,
	stream,
}: ReplayStringBodiesOptions): Promise<StreamGenerationState> {
	const handle = s2.basin(basin).stream(stream);
	try {
		const session = await handle
			.readSession({
				start: { from: { seqNum: 0 }, clamp: true },
				stop: { waitSecs: 0 },
			}, { as: "string" })
			.catch((error: unknown) => {
				if (isMissingStreamError(error)) return null;
				throw error;
			});
		if (!session) return emptyGenerationState();

		const state = emptyGenerationState();
		for await (const record of session) {
			state.nextSeqNum = record.seqNum + 1;
			if (!isFenceRecord(record)) {
				continue;
			}
			if (isTerminalFence(record)) {
				state.latestGenerationActive = false;
				state.reusableFenceToken = record.body;
				continue;
			}
			state.latestStartSeqNum = record.seqNum;
			state.latestGenerationActive = true;
			state.reusableFenceToken = null;
		}
		return state;
	} finally {
		await handle.close();
	}
}

export async function getReusableFenceToken({
	s2,
	basin,
	stream,
}: ReplayStringBodiesOptions): Promise<{
	fencingToken: string | null;
	nextSeqNum: number;
}> {
	const state = await inspectStreamGenerationState({ s2, basin, stream });
	return {
		fencingToken: state.reusableFenceToken,
		nextSeqNum: state.nextSeqNum,
	};
}

export async function* replayStringBodies({
	s2,
	basin,
	stream,
}: ReplayStringBodiesOptions): AsyncIterable<string> {
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

export async function* replayActiveStringBodies({
	s2,
	basin,
	stream,
}: ReplayStringBodiesOptions): AsyncIterable<string> {
	const state = await inspectStreamGenerationState({ s2, basin, stream });
	if (state.latestStartSeqNum === null) return;
	if (!state.latestGenerationActive) return;

	const handle = s2.basin(basin).stream(stream);
	try {
		const session = await handle.readSession(
			{
				start: { from: { seqNum: state.latestStartSeqNum } },
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

export async function* replayGenerationStringBodies({
	s2,
	basin,
	stream,
	fromSeqNum,
}: ReplayStringBodiesOptions & {
	fromSeqNum: number;
}): AsyncIterable<string> {
	const handle = s2.basin(basin).stream(stream);
	try {
		const session = await handle
			.readSession(
				{
					start: { from: { seqNum: fromSeqNum }, clamp: true },
				},
				{ as: "string" },
			)
			.catch((error: unknown) => {
				if (isMissingStreamError(error)) return null;
				throw error;
			});
		if (!session) return;

		for await (const record of session) {
			if (record.seqNum < fromSeqNum) {
				continue;
			}
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
