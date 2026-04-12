import type {
	ReadBatch,
	S2Endpoints,
	S2EndpointsInit,
} from "@s2-dev/streamstore";
import {
	AppendRecord,
	FencingTokenMismatchError,
	RangeNotSatisfiableError,
	S2,
	S2Environment,
} from "@s2-dev/streamstore";
import {
	appendFenceCommand,
	isFenceRecord,
	isTerminalFence,
	persistToS2,
	replayStringBodies,
} from "./protocol.js";

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
	const { accessToken, basin, batchSize, lingerDuration, endpoints } =
		getS2Config();
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
		await appendFenceCommand(s2, basin, streamId, "", sessionFencingToken);
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
		try {
			await persistToS2({
				s2,
				basin,
				stream: streamId,
				source: readableStreamToAsyncIterable(persistentStream),
				fencingToken: sessionFencingToken,
				batchSize,
				lingerDuration,
				toRecord: (value) => AppendRecord.string({ body: value }),
				terminalFenceBody: (failed) =>
					`${failed ? "error" : "end"}-${generateFencingToken()}`,
				onSeqNumMismatch: () => {
					debugLog("seqNum mismatch, skipping record");
				},
			});
		} catch (error) {
			debugLog("Error processing stream:", error);
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
				for await (const value of replayStringBodies({
					s2,
					basin,
					stream: streamId,
				})) {
					try {
						controller.enqueue(value);
					} catch (error: unknown) {
						if (
							error instanceof Error &&
							"code" in error &&
							(error as NodeJS.ErrnoException).code === "ERR_INVALID_STATE"
						) {
							debugLog("Likely page refresh caused stream closure:", streamId);
							return;
						}
						throw error;
					}
				}
				debugLog("Closing stream due to completion:", streamId);
				controller.close();
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

function isStreamDone(readBatch: ReadBatch): boolean {
	if (!readBatch.records || readBatch.records.length === 0) {
		return false;
	}

	const lastRecord = readBatch.records[0];
	if (!isFenceRecord(lastRecord)) {
		return false;
	}

	return isTerminalFence(lastRecord);
}

async function* readableStreamToAsyncIterable(
	stream: ReadableStream<string>,
): AsyncIterable<string> {
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

function debugLog(...messages: unknown[]) {
	if (process.env.DEBUG || process.env.NODE_ENV === "test") {
		console.log(...messages);
	}
}
