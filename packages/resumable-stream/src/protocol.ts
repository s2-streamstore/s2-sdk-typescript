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
	utf8ByteLength,
} from "@s2-dev/streamstore";

const PART_HEADER = "part";

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

function splitUtf8(text: string, maxBytes: number): string[] {
	const parts: string[] = [];
	let start = 0;
	let bytes = 0;
	for (let i = 0; i < text.length; ) {
		const code = text.codePointAt(i)!;
		const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
		if (bytes + size > maxBytes) {
			parts.push(text.slice(start, i));
			start = i;
			bytes = 0;
		}
		bytes += size;
		i += code > 0xffff ? 2 : 1;
	}
	parts.push(text.slice(start));
	return parts;
}

export function dataRecords(body: string): AppendRecord[] {
	if (utf8ByteLength(body) <= AppendRecord.maxBodyBytes()) {
		return [AppendRecord.string({ body })];
	}
	const parts = splitUtf8(
		body,
		AppendRecord.maxBodyBytes([[PART_HEADER, "first"]]),
	);
	return parts.map((part, i) =>
		AppendRecord.string({
			body: part,
			headers: [
				[
					PART_HEADER,
					i === 0 ? "first" : i === parts.length - 1 ? "last" : "more",
				],
			],
		}),
	);
}

export function createPartAssembler(): (
	record: Pick<ReadRecord<"string">, "headers" | "body">,
) => string | undefined {
	let pending: string | null = null;
	return (record) => {
		const header = record.headers?.[0];
		if (record.headers?.length !== 1 || header?.[0] !== PART_HEADER) {
			return record.body;
		}
		if (header[1] === "first") {
			pending = record.body;
			return undefined;
		}
		if (pending === null) return undefined;
		pending += record.body;
		if (header[1] !== "last") return undefined;
		const body = pending;
		pending = null;
		return body;
	};
}

export interface PersistToS2Options<T> {
	s2: S2;
	basin: string;
	stream: string;
	source: AsyncIterable<T>;
	fencingToken: string;
	batchSize: number;
	lingerDuration: number;
	toRecords: (value: T) => ReadonlyArray<AppendRecord>;
	finalRecords: (sourceError: unknown) => ReadonlyArray<AppendRecord>;
	matchSeqNumStart?: number;
	onSeqNumMismatch?: (error: SeqNumMismatchError) => void;
	/** Called when an append fails while the source is still running. */
	abortSource?: () => void;
	/** Called with a source record's sequence number once it is durable. */
	onAppended?: (seqNum: number) => void;
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
	toRecords,
	finalRecords,
	matchSeqNumStart,
	onSeqNumMismatch,
	abortSource,
	onAppended,
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
				for (const record of toRecords(value)) {
					const ticket = await producer.submit(record);
					// A failed append must stop an idle source, not wait for its next chunk.
					ticket.ack().then(
						(ack) => onAppended?.(ack.seqNum()),
						() => abortSource?.(),
					);
				}
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
			if (finalizationError !== undefined || closeError !== undefined) {
				const records = finalRecords(failure);
				const appendDirect = async (batch: AppendRecord[]) => {
					await handle.append(AppendInput.create(batch, { fencingToken }));
				};
				// If the error chunk doesn't fit, the fence alone still ends readers.
				await appendDirect([...records])
					.catch(() => appendDirect(records.slice(-1)))
					.catch(() => {});
			}
			throw failure;
		}
	} finally {
		await handle.close();
	}
}
