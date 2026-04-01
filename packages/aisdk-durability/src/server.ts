import {
	AppendInput,
	AppendRecord,
	BatchTransform,
	FencingTokenMismatchError,
	Producer,
	S2,
	SeqNumMismatchError,
	randomToken,
} from "@s2-dev/streamstore";
import type {
	S2ChatPersistence,
	S2ChatPersistenceConfig,
	PersistOptions,
} from "./types.js";
import { isFenceRecord, isTerminalFence } from "./fence.js";

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LINGER_DURATION = 50;

async function writeFence(
	s2: S2,
	basin: string,
	stream: string,
	currentToken: string,
	newToken: string,
): Promise<void> {
	const record = AppendRecord.fence(newToken);
	const input = AppendInput.create([record], { fencingToken: currentToken });
	await s2.basin(basin).stream(stream).append(input);
}

async function persistChunks(
	s2: S2,
	basin: string,
	stream: string,
	source: AsyncIterable<unknown>,
	fencingToken: string,
	batchSize: number,
	lingerDuration: number,
): Promise<void> {
	const handle = s2.basin(basin).stream(stream);
	try {
		const session = await handle.appendSession();
		const transform = new BatchTransform({
			lingerDurationMillis: lingerDuration,
			maxBatchRecords: batchSize,
			fencingToken,
			matchSeqNum: 1,
		});
		const producer = new Producer(transform, session);

		let sourceError: unknown;
		try {
			for await (const chunk of source) {
				// Fire-and-forget: SeqNumMismatchError is safe to ignore.
				// Other submit errors surface via producer.close().
				producer
					.submit(AppendRecord.string({ body: JSON.stringify(chunk) }))
					.catch((err: unknown) => {
						if (err instanceof SeqNumMismatchError) return;
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
		try {
			await writeFence(
				s2,
				basin,
				stream,
				fencingToken,
				failed ? `error-${randomToken(4)}` : `end-${randomToken(4)}`,
			);
		} catch {
			// best-effort
		}

		if (failed) throw failed;
	} finally {
		await handle.close();
	}
}

/**
 * Create a persistence context for writing AI SDK streams to S2.
 *
 * Returns an object with two methods:
 *
 * - **`persist(streamName, source, options?)`** — write an AI SDK stream to
 *   S2 and return a `{ stream }` JSON response. When `waitUntil` is provided
 *   the write runs in the background so the response is sent immediately;
 *   otherwise it completes the write first.
 *
 * - **`replay(streamName)`** — read a persisted stream from S2 and return a
 *   streaming NDJSON response. Use this for a server-side reconnect endpoint
 *   when S2 credentials should stay server-side.
 *
 * @example
 * ```ts
 * // lib/s2.ts — create once, import everywhere
 * import { createS2ChatPersistence } from "@s2-dev/aisdk-transport";
 *
 * export const chat = createS2ChatPersistence({
 *   accessToken: process.env.S2_ACCESS_TOKEN!,
 *   basin: process.env.S2_BASIN!,
 * });
 * ```
 *
 * ```ts
 * // app/api/chat/route.ts
 * import { after } from "next/server";
 * import { streamText } from "ai";
 * import { chat } from "@/lib/s2";
 *
 * export async function POST(req: Request) {
 *   const { id, messages } = await req.json();
 *   const result = streamText({ model, messages });
 *   return chat.persist(id, result.fullStream, { waitUntil: after });
 * }
 * ```
 */
export function createS2ChatPersistence(
	config: S2ChatPersistenceConfig,
): S2ChatPersistence {
	const s2 = new S2({
		accessToken: config.accessToken,
		endpoints: config.endpoints,
	});
	const basin = config.basin;
	const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
	const lingerDuration = config.lingerDuration ?? DEFAULT_LINGER_DURATION;

	return {
		async persist(
			streamName: string,
			source: AsyncIterable<unknown>,
			options?: PersistOptions,
		): Promise<Response> {
			const fencingToken = `session-${randomToken(8)}`;

			// Claim the stream. An empty fencing token asserts nobody else owns it.
			try {
				await writeFence(s2, basin, streamName, "", fencingToken);
			} catch (err) {
				if (err instanceof FencingTokenMismatchError) {
					return new Response("Stream already in use", { status: 409 });
				}
				throw err;
			}

			const write = persistChunks(
				s2,
				basin,
				streamName,
				source,
				fencingToken,
				batchSize,
				lingerDuration,
			);

			if (options?.waitUntil) {
				options.waitUntil(
					write.catch((err) =>
						console.error("[s2/aisdk-transport] persist failed:", err),
					),
				);
			} else {
				await write;
			}

			return Response.json(
				{ stream: streamName },
				{ headers: { "Cache-Control": "no-store" } },
			);
		},

		async replay(streamName: string): Promise<Response> {
			const encoder = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				async start(controller) {
					const handle = s2.basin(basin).stream(streamName);
					try {
						const session = await handle.readSession({
							start: { from: { seqNum: 0 } },
						});
						for await (const record of session) {
							if (isFenceRecord(record)) {
								if (isTerminalFence(record)) break;
								continue;
							}
							if (record.body) {
								controller.enqueue(
									encoder.encode(`${record.body}\n`),
								);
							}
						}
						controller.close();
					} catch (err) {
						controller.error(err);
					} finally {
						await handle.close();
					}
				},
			});

			return new Response(body, {
				headers: {
					"Content-Type": "application/x-ndjson",
					"Cache-Control": "no-store",
					"X-Accel-Buffering": "no",
				},
			});
		},
	};
}
