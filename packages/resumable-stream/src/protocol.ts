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
	const command = AppendInput.create([AppendRecord.fence(newToken)], {
		fencingToken: currentToken ?? undefined,
	});
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
			await appendFenceCommand(
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
