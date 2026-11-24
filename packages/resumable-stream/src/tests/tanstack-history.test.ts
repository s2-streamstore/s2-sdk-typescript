import { AppendRecord, type ReadRecord } from "@s2-dev/streamstore";
import { afterAll, expect, it, vi } from "vitest";
import { dataRecords } from "../protocol.js";

const state = vi.hoisted(() => ({ records: [] as ReadRecord<"string">[] }));

vi.mock("@s2-dev/streamstore", async () => {
	const actual = await vi.importActual<typeof import("@s2-dev/streamstore")>(
		"@s2-dev/streamstore",
	);
	return {
		...actual,
		S2: class {
			basin() {
				return {
					stream: () => ({
						async readSession(input: {
							start: { from: { seqNum?: number; tailOffset?: number } };
						}) {
							const from = input.start.from;
							const start =
								from.seqNum ??
								Math.max(0, state.records.length - from.tailOffset!);
							const records = state.records.filter(
								(record) => record.seqNum >= start,
							);
							return new ReadableStream<ReadRecord<"string">>({
								start(controller) {
									for (const record of records) controller.enqueue(record);
									controller.close();
								},
							});
						},
						async close() {},
					}),
				};
			}
		},
	};
});

afterAll(() => vi.unstubAllEnvs());

it("PR #398: history reload and its replay cursor preserve multipart snapshots", async () => {
	vi.stubEnv("S2_ACCESS_TOKEN", "test");
	vi.stubEnv("S2_BASIN", "test");
	const { historyChat, replayChat } = await import(
		"../../../../examples/tanstack-ai-chat/src/server/chat.js"
	);
	const messages = (content: string) => [
		{ id: "m", role: "user", parts: [{ type: "text", content }] },
	];
	const snapshot = (content: string) => ({
		type: "MESSAGES_SNAPSHOT",
		messages: messages(content),
	});
	const large = snapshot("😀".repeat(300_000));
	const encoded = dataRecords(JSON.stringify(large));
	const append = (records: AppendRecord[]) => {
		for (const record of records) {
			state.records.push({
				seqNum: state.records.length,
				timestamp: new Date(),
				headers: record.headers ?? [],
				body:
					typeof record.body === "string"
						? record.body
						: new TextDecoder().decode(record.body),
			});
		}
	};
	append([
		AppendRecord.fence("session-a"),
		...dataRecords(JSON.stringify(snapshot("previous"))),
		encoded[0]!,
	]);

	// Loading history in the middle of a chunk must leave its first part replayable.
	const partial = await (await historyChat("chat")).json();
	expect(partial).toEqual({ messages: messages("previous"), cursor: 2 });
	append([...encoded.slice(1), AppendRecord.fence("end-a")]);
	const replay = await replayChat("chat", String(partial.cursor));
	const replayed = (await replay.text())
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => JSON.parse(line.slice(6)));
	expect(replayed).toEqual([large]);

	const complete = await (await historyChat("chat")).json();
	expect(complete).toEqual({
		messages: large.messages,
		cursor: 2 + encoded.length,
	});
}, 2000);
