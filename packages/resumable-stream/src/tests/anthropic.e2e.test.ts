import type {
	Message,
	RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import { S2, S2Environment } from "@s2-dev/streamstore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accumulateMessage } from "../anthropic/accumulator.js";
import { type Chunk, createResumableChat } from "../anthropic/index.js";

const TEST_TIMEOUT_MS = 120_000;
const hasEnv = !!process.env.S2_ACCESS_TOKEN;
const describeIf = hasEnv ? describe : describe.skip;

const makeBasinName = (): string => {
	const suffix = Math.random().toString(36).slice(2, 10);
	return `resumable-anthr-${suffix}`.slice(0, 48);
};
const makeStreamName = (prefix: string): string =>
	`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

async function waitForBasinReady(s2: S2, basin: string): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			await s2.basins.getConfig({ basin });
			return;
		} catch (err) {
			const status =
				err && typeof err === "object" && "status" in err
					? (err as { status?: number }).status
					: undefined;
			if (status === 503) {
				await sleep(500);
				continue;
			}
			throw err;
		}
	}
	throw new Error(`Timed out waiting for basin ${basin}`);
}

async function* arrayToAsyncIterable<T>(items: T[]): AsyncIterable<T> {
	for (const item of items) yield item;
}

async function* delayedAsyncIterable<T>(
	items: T[],
	delayMs = 25,
): AsyncIterable<T> {
	for (let index = 0; index < items.length; index += 1) {
		yield items[index]!;
		if (index < items.length - 1) {
			await sleep(delayMs);
		}
	}
}

async function* heldOpenAsyncIterable<T>(
	items: T[],
	release: Promise<void>,
	delayMs = 25,
): AsyncIterable<T> {
	if (items.length === 0) return;
	yield items[0]!;
	await release;
	for (let index = 1; index < items.length; index += 1) {
		if (delayMs > 0) await sleep(delayMs);
		yield items[index]!;
	}
}

async function* throwingIterable<T>(
	items: T[],
	error: Error,
): AsyncIterable<T> {
	for (const item of items) yield item;
	throw error;
}

interface ParsedSseFrame {
	event?: string;
	data: unknown;
	id?: number;
}

async function readAnthropicSse(res: Response): Promise<ParsedSseFrame[]> {
	const text = await res.text();
	const frames: ParsedSseFrame[] = [];
	for (const block of text.split("\n\n")) {
		if (!block.trim()) continue;
		const frame: ParsedSseFrame = { data: undefined };
		for (const line of block.split("\n")) {
			if (line.startsWith("event: "))
				frame.event = line.slice("event: ".length);
			else if (line.startsWith("data: ")) {
				const payload = line.slice("data: ".length);
				try {
					frame.data = JSON.parse(payload);
				} catch {
					frame.data = payload;
				}
			} else if (line.startsWith("id: ")) {
				frame.id = Number.parseInt(line.slice("id: ".length), 10);
			}
		}
		if (frame.data !== undefined) frames.push(frame);
	}
	return frames;
}

const baseUsage = {
	input_tokens: 5,
	output_tokens: 1,
	cache_creation_input_tokens: 0,
	cache_read_input_tokens: 0,
};

function textTurnEvents(id: string, text: string): RawMessageStreamEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id,
				type: "message",
				role: "assistant",
				model: "claude-opus-4-7",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				container: null,
				stop_details: null,
				usage: baseUsage,
			},
		} as unknown as RawMessageStreamEvent,
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		} as unknown as RawMessageStreamEvent,
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		} as unknown as RawMessageStreamEvent,
		{ type: "content_block_stop", index: 0 } as RawMessageStreamEvent,
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 5 },
		} as unknown as RawMessageStreamEvent,
		{ type: "message_stop" } as RawMessageStreamEvent,
	];
}

function s2EndpointsFromEnv(): {
	endpoints?: { account?: string; basin?: string };
} {
	const account = process.env.S2_ACCOUNT_ENDPOINT || undefined;
	const basin = process.env.S2_BASIN_ENDPOINT || undefined;
	if (account || basin) return { endpoints: { account, basin } };
	return {};
}

let s2: S2;
let basinName: string;

describeIf("resumable-stream/anthropic", () => {
	beforeAll(async () => {
		const env = S2Environment.parse();
		s2 = new S2(env as { accessToken: string });
		basinName = makeBasinName();
		try {
			await s2.basins.create({
				basin: basinName,
				config: { createStreamOnAppend: true, createStreamOnRead: true },
			});
		} catch (err: unknown) {
			if (
				err &&
				typeof err === "object" &&
				"status" in err &&
				(err as { status: number }).status === 422 &&
				String(err).includes("free tier")
			)
				return;
			throw err;
		}
		await waitForBasinReady(s2, basinName);
	}, TEST_TIMEOUT_MS);

	afterAll(async () => {
		if (!s2 || !basinName) return;
		try {
			await s2.basins.delete({ basin: basinName });
		} catch {
			// best-effort
		}
	}, TEST_TIMEOUT_MS);

	it(
		"emits Anthropic-native SSE on the live response (event:, data:, id:)",
		async () => {
			const chat = createResumableChat({
				accessToken: process.env.S2_ACCESS_TOKEN!,
				basin: basinName,
				...s2EndpointsFromEnv(),
			});
			const streamName = makeStreamName("anthr-live");
			const events = textTurnEvents("msg_live", "Hello, live!");

			const res = await chat.makeResumable(
				streamName,
				arrayToAsyncIterable(events) as AsyncIterable<Chunk>,
			);
			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toBe("text/event-stream");

			const frames = await readAnthropicSse(res);
			expect(frames).toHaveLength(events.length);
			for (let i = 0; i < events.length; i += 1) {
				expect(frames[i]?.event).toBe(events[i]!.type);
				expect(frames[i]?.data).toEqual(events[i]);
			}
			// ids monotonic and start at >0 (record 0 is the opening fence).
			const ids = frames.map((f) => f.id);
			expect(
				ids.every((id) => Number.isInteger(id) && (id as number) > 0),
			).toBe(true);
			for (let i = 1; i < ids.length; i += 1) {
				expect((ids[i] as number) > (ids[i - 1] as number)).toBe(true);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"replay during an active single-use generation yields the same events as live",
		async () => {
			const chat = createResumableChat({
				accessToken: process.env.S2_ACCESS_TOKEN!,
				basin: basinName,
				...s2EndpointsFromEnv(),
			});
			const streamName = makeStreamName("anthr-replay");
			const events = textTurnEvents("msg_replay", "Replay me");
			const releaseSource = deferred();

			// Cancel the live response immediately — the persist branch keeps writing.
			let bg: Promise<unknown> | undefined;
			const live = await chat.makeResumable(
				streamName,
				heldOpenAsyncIterable(
					events,
					releaseSource.promise,
				) as AsyncIterable<Chunk>,
				{
					waitUntil: (p) => {
						bg = p;
					},
				},
			);
			await live.body?.cancel();

			// Replay tails the active generation until the terminal fence arrives.
			const replay = await chat.replay(streamName);
			releaseSource.resolve();
			expect(replay.status).toBe(200);
			expect(replay.headers.get("Content-Type")).toBe("text/event-stream");
			const replayFrames = await readAnthropicSse(replay);
			await bg;

			expect(replayFrames).toHaveLength(events.length);
			for (let i = 0; i < events.length; i += 1) {
				expect(replayFrames[i]?.event).toBe(events[i]!.type);
				expect(replayFrames[i]?.data).toEqual(events[i]);
			}
			const ids = replayFrames.map((f) => f.id);
			for (let i = 1; i < ids.length; i += 1) {
				expect((ids[i] as number) > (ids[i - 1] as number)).toBe(true);
			}
			const reconstructed = accumulateMessage(
				replayFrames.map((f) => f.data) as RawMessageStreamEvent[],
			);
			expect(reconstructed.id).toBe("msg_replay");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"session-mode cursor reconnect via ?from=N yields only later frames",
		async () => {
			const chat = createResumableChat({
				accessToken: process.env.S2_ACCESS_TOKEN!,
				basin: basinName,
				mode: "session",
				...s2EndpointsFromEnv(),
			});
			const streamName = makeStreamName("anthr-cursor");
			const events = textTurnEvents("msg_cursor", "Cursor reconnect");

			let bg: Promise<unknown> | undefined;
			const live = await chat.makeResumable(
				streamName,
				arrayToAsyncIterable(events) as AsyncIterable<Chunk>,
				{
					waitUntil: (p) => {
						bg = p;
					},
				},
			);
			const liveFrames = await readAnthropicSse(live);
			await bg;
			expect(liveFrames).toHaveLength(events.length);

			const splitIdx = 3;
			const cursor = liveFrames[splitIdx]?.id;
			expect(typeof cursor).toBe("number");

			// Session-mode replay tails forever; abort once we've seen the rest.
			const ac = new AbortController();
			const tailRes = await chat.replay(streamName, { fromSeqNum: cursor });
			const tailFrames: ParsedSseFrame[] = [];
			const reader = tailRes.body!.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			const expectedTailCount = events.length - splitIdx - 1;
			outer: while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let idx: number;
				while ((idx = buffer.indexOf("\n\n")) !== -1) {
					const block = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 2);
					const frame: ParsedSseFrame = { data: undefined };
					for (const line of block.split("\n")) {
						if (line.startsWith("event: ")) frame.event = line.slice(7);
						else if (line.startsWith("data: ")) {
							try {
								frame.data = JSON.parse(line.slice(6));
							} catch {}
						} else if (line.startsWith("id: ")) {
							frame.id = Number.parseInt(line.slice(4), 10);
						}
					}
					if (frame.data !== undefined) tailFrames.push(frame);
					if (tailFrames.length >= expectedTailCount) {
						ac.abort();
						await reader.cancel().catch(() => {});
						break outer;
					}
				}
			}

			expect(tailFrames).toHaveLength(expectedTailCount);
			for (const f of tailFrames) {
				expect((f.id as number) > (cursor as number)).toBe(true);
			}

			// Head + tail recombines to the full message.
			const head = liveFrames.slice(0, splitIdx + 1);
			const combined = [...head, ...tailFrames];
			const recovered = accumulateMessage(
				combined.map((f) => f.data) as RawMessageStreamEvent[],
			);
			expect(recovered.id).toBe("msg_cursor");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"session mode persists multiple turns; history returns each as a Message",
		async () => {
			const chat = createResumableChat({
				accessToken: process.env.S2_ACCESS_TOKEN!,
				basin: basinName,
				mode: "session",
				...s2EndpointsFromEnv(),
			});
			const streamName = makeStreamName("anthr-session");
			const turn1 = textTurnEvents("msg_t1", "Hi from turn one");
			const turn2 = textTurnEvents("msg_t2", "And turn two");

			let bg1: Promise<unknown> | undefined;
			const r1 = await chat.makeResumable(
				streamName,
				arrayToAsyncIterable(turn1) as AsyncIterable<Chunk>,
				{
					waitUntil: (p) => {
						bg1 = p;
					},
				},
			);
			await r1.body?.cancel();
			await bg1;

			let bg2: Promise<unknown> | undefined;
			const r2 = await chat.makeResumable(
				streamName,
				arrayToAsyncIterable(turn2) as AsyncIterable<Chunk>,
				{
					waitUntil: (p) => {
						bg2 = p;
					},
				},
			);
			await r2.body?.cancel();
			await bg2;

			// History returns one Message per closed turn, in order.
			const hist = await chat.history(streamName);
			expect(hist.status).toBe(200);
			const json = (await hist.json()) as { messages: Message[] };
			expect(json.messages).toHaveLength(2);
			expect(json.messages[0]?.id).toBe("msg_t1");
			expect(json.messages[1]?.id).toBe("msg_t2");
			if (json.messages[0]?.content[0]?.type === "text") {
				expect(json.messages[0].content[0].text).toBe("Hi from turn one");
			}
			if (json.messages[1]?.content[0]?.type === "text") {
				expect(json.messages[1].content[0].text).toBe("And turn two");
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"history excludes a turn that hasn't yet emitted message_stop",
		async () => {
			const chat = createResumableChat({
				accessToken: process.env.S2_ACCESS_TOKEN!,
				basin: basinName,
				mode: "session",
				...s2EndpointsFromEnv(),
			});
			const streamName = makeStreamName("anthr-inflight");

			// Turn 1: closed.
			let bg1: Promise<unknown> | undefined;
			const r1 = await chat.makeResumable(
				streamName,
				arrayToAsyncIterable(
					textTurnEvents("msg_done", "done"),
				) as AsyncIterable<Chunk>,
				{
					waitUntil: (p) => {
						bg1 = p;
					},
				},
			);
			await r1.body?.cancel();
			await bg1;

			// Turn 2: only message_start + a delta, no message_stop. Use a short
			// delay so the persist task lands the events before we read history.
			const partial = textTurnEvents("msg_inflight", "in flight").slice(0, 3);
			let bg2: Promise<unknown> | undefined;
			const r2 = await chat.makeResumable(
				streamName,
				arrayToAsyncIterable(partial) as AsyncIterable<Chunk>,
				{
					waitUntil: (p) => {
						bg2 = p;
					},
				},
			);
			await r2.body?.cancel();
			await bg2;

			const hist = await chat.history(streamName);
			const json = (await hist.json()) as { messages: Message[] };
			expect(json.messages).toHaveLength(1);
			expect(json.messages[0]?.id).toBe("msg_done");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"reconstructs a tool_use turn from input_json_delta partials end-to-end",
		async () => {
			const chat = createResumableChat({
				accessToken: process.env.S2_ACCESS_TOKEN!,
				basin: basinName,
				...s2EndpointsFromEnv(),
			});
			const streamName = makeStreamName("anthr-tooluse");
			// Use the live response (single-use replay closes after terminal fence).
			const events: RawMessageStreamEvent[] = [
				{
					type: "message_start",
					message: {
						id: "msg_tool",
						type: "message",
						role: "assistant",
						model: "claude-opus-4-7",
						content: [],
						stop_reason: null,
						stop_sequence: null,
						container: null,
						stop_details: null,
						usage: baseUsage,
					},
				} as unknown as RawMessageStreamEvent,
				{
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "tool_use",
						id: "tu_1",
						name: "lookup",
						input: {},
					},
				} as unknown as RawMessageStreamEvent,
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"q":"' },
				} as unknown as RawMessageStreamEvent,
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: 'hi"}' },
				} as unknown as RawMessageStreamEvent,
				{ type: "content_block_stop", index: 0 } as RawMessageStreamEvent,
				{
					type: "message_delta",
					delta: { stop_reason: "tool_use", stop_sequence: null },
					usage: { output_tokens: 5 },
				} as unknown as RawMessageStreamEvent,
				{ type: "message_stop" } as RawMessageStreamEvent,
			];

			let bg: Promise<unknown> | undefined;
			const live = await chat.makeResumable(
				streamName,
				arrayToAsyncIterable(events) as AsyncIterable<Chunk>,
				{
					waitUntil: (p) => {
						bg = p;
					},
				},
			);
			const frames = await readAnthropicSse(live);
			await bg;
			const message = accumulateMessage(
				frames.map((f) => f.data) as RawMessageStreamEvent[],
			);
			expect(message.content[0]?.type).toBe("tool_use");
			if (message.content[0]?.type === "tool_use") {
				expect(message.content[0].input).toEqual({ q: "hi" });
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"emits an error event when the source throws mid-stream",
		async () => {
			const chat = createResumableChat({
				accessToken: process.env.S2_ACCESS_TOKEN!,
				basin: basinName,
				...s2EndpointsFromEnv(),
			});
			const streamName = makeStreamName("anthr-error");
			const partial = textTurnEvents("msg_err", "partial").slice(0, 3);

			// `persistToS2` re-throws the source error after writing the error
			// chunk + terminal fence. Swallow the rejection on the bg promise.
			let bg: Promise<unknown> | undefined;
			const live = await chat.makeResumable(
				streamName,
				throwingIterable(partial, new Error("boom")) as AsyncIterable<Chunk>,
				{
					waitUntil: (p) => {
						bg = p.catch(() => {});
					},
				},
			);
			const liveFrames = await readAnthropicSse(live);
			await bg;
			expect(liveFrames.at(-1)?.event).toBe("error");
		},
		TEST_TIMEOUT_MS,
	);
});
