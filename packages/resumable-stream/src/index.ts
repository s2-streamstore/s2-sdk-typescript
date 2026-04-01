import type {
	ReadBatch,
	ReadRecord,
	S2Endpoints,
	S2EndpointsInit,
} from "@s2-dev/streamstore";
import {
	AppendInput,
	AppendRecord,
	BatchTransform,
	FencingTokenMismatchError,
	Producer,
	RangeNotSatisfiableError,
	S2,
	S2Environment,
	SeqNumMismatchError,
} from "@s2-dev/streamstore";

interface S2Config {
	/**
	 * Access token for S2.
	 */
	readonly accessToken: string;
	/**
	 * Globally unique basin name.
	 */
	readonly basin: string;
	/**
	 * Number of records to batch together when appending to S2.
	 * Defaults to 10 if not set.
	 */
	readonly batchSize: number;
	/**
	 * Maximum time to wait before flushing a batch (in milliseconds).
	 * Defaults to 5000 if not set.
	 */
	readonly lingerDuration: number;
	/**
	 * Optional endpoint overrides (e.g. for s2-lite).
	 * Populated from S2_ACCOUNT_ENDPOINT / S2_BASIN_ENDPOINT env vars.
	 */
	readonly endpoints?: S2Endpoints | S2EndpointsInit;
}

export interface CreateResumableStreamContextOptions {
	/**
	 * A function that takes a promise and ensures that the current program stays alive until the promise is resolved.
	 */
	waitUntil: (promise: Promise<unknown>) => void;
}

interface CreateResumableStreamContext {
	waitUntil: (promise: Promise<unknown>) => void;
}

export interface ResumableStreamContext {
	/**
	 * Creates a resumable stream from the provided input stream.
	 * The stream will be persisted in S2 and can be resumed later.
	 * @param streamId - Unique identifier for the stream.
	 * @param makeStream - Factory function that creates the ReadableStream to persist.
	 * @returns A ReadableStream that can be used to read.
	 */
	resumableStream: (
		streamId: string,
		makeStream: () => ReadableStream<string>,
	) => Promise<ReadableStream<string> | null>;
	/**
	 * Resumes a previously created stream by its ID.
	 * @param streamId - Unique identifier for the stream to resume.
	 * @returns A ReadableStream that can be used to read.
	 */
	resumeStream: (streamId: string) => Promise<ReadableStream<string> | null>;
	/**
	 * Stops a stream by its ID.
	 * @param streamId - Unique identifier for the stream to stop.
	 */
	stopStream: (streamId: string) => Promise<void>;
}

function generateFencingToken(): string {
	return Math.random().toString(36).slice(2, 7);
}

function getS2Config(): S2Config {
	const accessToken = process.env.S2_ACCESS_TOKEN;
	const basin = process.env.S2_BASIN;
	const batchSize = Number.parseInt(process.env.S2_BATCH_SIZE ?? "10", 10);
	const lingerDuration = Number.parseInt(
		process.env.S2_LINGER_DURATION ?? "5000",
		10,
	);

	if (!accessToken) throw new Error("S2_ACCESS_TOKEN is not set");
	if (!basin) throw new Error("S2_BASIN is not set");

	const { endpoints } = S2Environment.parse();
	return { accessToken, basin, batchSize, lingerDuration, endpoints };
}

export function createResumableStreamContext(
	options: CreateResumableStreamContextOptions,
): ResumableStreamContext {
	const ctx = {
		waitUntil: options.waitUntil,
	} as CreateResumableStreamContext;

	getS2Config();
	return {
		resumableStream: async (
			streamId: string,
			makeStream: () => ReadableStream<string>,
		) => {
			return await createResumableStream(ctx, makeStream, streamId);
		},
		resumeStream: async (streamId: string) => {
			return await resumeStream(streamId);
		},
		stopStream: async (streamId: string) => {
			return await stopStream(streamId);
		},
	};
}

export async function createResumableStream(
	ctx: CreateResumableStreamContext,
	makeStream: () => ReadableStream<string>,
	streamId: string,
): Promise<ReadableStream<string> | null> {
	const { accessToken, basin, batchSize, lingerDuration, endpoints } = getS2Config();
	const s2 = new S2({ accessToken, endpoints });
	const [persistentStream, clientStream] = makeStream().tee();
	const sessionFencingToken = "session-" + generateFencingToken();

	try {
		const lastRecord = await s2
			.basin(basin)
			.stream(streamId)
			.read({
				start: { from: { tailOffset: 1 } },
				stop: { limits: { count: 1 } },
			});

		if (isStreamDone(lastRecord)) {
			debugLog("Stream already ended, not resuming:", streamId);
			return null;
		}
	} catch (error: unknown) {
		if (error instanceof RangeNotSatisfiableError) {
			debugLog("Got RangeNotSatisfiableError:", error);
		} else {
			debugLog("Error checking stream status:", error);
			return null;
		}
	}

	// in case of multiple writers, only one with the given fencing token will succeed
	try {
		await appendFenceCommand(s2, basin, streamId, null, sessionFencingToken);
	} catch (error: unknown) {
		if (error instanceof FencingTokenMismatchError) {
			debugLog(
				"Stream already exists, resuming existing stream:",
				streamId,
				error,
			);
			return await resumeStream(streamId);
		}
		debugLog("Error initializing stream:", error);
		return null;
	}

	const persistStream = async () => {
		const reader = persistentStream.getReader();

		const stream = s2.basin(basin).stream(streamId);
		const session = await stream.appendSession();
		const batchTransform = new BatchTransform({
			lingerDurationMillis: lingerDuration,
			maxBatchRecords: batchSize,
			fencingToken: sessionFencingToken,
			matchSeqNum: 1, // First data record after fence command at seq_num 0
		});
		const producer = new Producer(batchTransform, session);

		try {
			let terminated = false;

			while (!terminated) {
				const { done, value } = await reader.read();

				if (done) {
					terminated = true;
					break;
				}

				producer
					.submit(AppendRecord.string({ body: value }))
					.catch((error: unknown) => {
						if (error instanceof SeqNumMismatchError) {
							debugLog("seqNum mismatch, skipping record");
							return;
						}
						throw error;
					});
			}

			await producer.close();

			await appendFenceCommand(
				s2,
				basin,
				streamId,
				sessionFencingToken,
				"end-" + generateFencingToken(),
			);
		} catch (error) {
			debugLog("Error processing stream:", error);
			try {
				await producer.close();
				await appendFenceCommand(
					s2,
					basin,
					streamId,
					sessionFencingToken,
					"error-" + generateFencingToken(),
				);
			} catch (fenceError) {
				debugLog("Error appending fence command:", fenceError);
			}
		} finally {
			reader.releaseLock();
		}
	};

	ctx.waitUntil(persistStream());
	return clientStream;
}

async function resumeStream(
	streamId: string,
): Promise<ReadableStream<string> | null> {
	const { accessToken, basin, endpoints } = getS2Config();
	const s2 = new S2({ accessToken, endpoints });
	debugLog("Resuming stream:", streamId);
	return new ReadableStream({
		async start(controller) {
			try {
				const session = await s2
					.basin(basin)
					.stream(streamId)
					.readSession({
						start: { from: { seqNum: 0 } },
					});
				await processStream(streamId, session, controller);
			} catch (error) {
				debugLog("Error reading stream:", error);
				return null;
			}
		},
	});
}

// appends a fence command with the previous fencing token as null
// (overriding the previous fencing token)
async function stopStream(streamId: string): Promise<void> {
	const { accessToken, basin, endpoints } = getS2Config();
	const s2 = new S2({ accessToken, endpoints });
	debugLog("Stopping stream:", streamId);

	try {
		await appendFenceCommand(
			s2,
			basin,
			streamId,
			null,
			"end-" + generateFencingToken(),
		);
	} catch (error) {
		debugLog("Error stopping stream:", error);
		throw error;
	}
}

async function appendFenceCommand(
	s2: S2,
	basin: string,
	streamId: string,
	prevFencingToken: string | null,
	newFencingToken: string,
): Promise<void> {
	const record = AppendRecord.fence(newFencingToken);
	const input = AppendInput.create([record], {
		fencingToken: prevFencingToken ?? undefined,
	});
	await s2.basin(basin).stream(streamId).append(input);
}

async function processStream(
	streamID: string,
	session: AsyncIterable<ReadRecord>,
	controller: ReadableStreamDefaultController<string>,
): Promise<void> {
	for await (const rec of session) {
		if (isFenceCommand(rec)) {
			if (rec.body?.startsWith("end")) {
				debugLog("Closing stream due to fence(end) command:", streamID);
				controller.close();
				return;
			}
			continue;
		}
		if (rec.body) {
			try {
				controller.enqueue(rec.body);
			} catch (error: unknown) {
				if (
					error instanceof Error &&
					"code" in error &&
					(error as NodeJS.ErrnoException).code === "ERR_INVALID_STATE"
				) {
					debugLog("Likely page refresh caused stream closure:", streamID);
					return;
				}
				throw error;
			}
		}
	}
	debugLog("Closing stream due to completion:", streamID);
	controller.close();
}

function isFenceCommand(record: ReadRecord): boolean {
	return (
		record.headers?.length === 1 &&
		record.headers[0][0] === "" &&
		record.headers[0][1] === "fence"
	);
}

function isStreamDone(readBatch: ReadBatch): boolean {
	if (!readBatch.records || readBatch.records.length === 0) {
		return false;
	}

	const lastRecord = readBatch.records[0];
	if (!isFenceCommand(lastRecord)) {
		return false;
	}

	const fenceBody = lastRecord.body;
	return (
		fenceBody !== null &&
		fenceBody !== undefined &&
		(fenceBody.startsWith("end-") || fenceBody.startsWith("error-"))
	);
}

function debugLog(...messages: unknown[]) {
	if (process.env.DEBUG || process.env.NODE_ENV === "test") {
		console.log(...messages);
	}
}
