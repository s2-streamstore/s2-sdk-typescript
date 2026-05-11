import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import { describe, expect, it } from "vitest";
import { createHistorySnapshot } from "../anthropic/history.js";

const usage = {
	input_tokens: 1,
	output_tokens: 1,
	cache_creation_input_tokens: 0,
	cache_read_input_tokens: 0,
};

function textTurn(id: string, text: string): RawMessageStreamEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id,
				type: "message",
				role: "assistant",
				model: "claude-haiku-4-5-20251001",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				container: null,
				stop_details: null,
				usage,
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
			usage: { output_tokens: 3 },
		} as unknown as RawMessageStreamEvent,
		{ type: "message_stop" } as RawMessageStreamEvent,
	];
}

function body(event: unknown): string {
	return JSON.stringify(event);
}

describe("createHistorySnapshot", () => {
	it("keeps assistant messages paired with their user after an errored turn", () => {
		const records = [
			{ seqNum: 0, body: "holder-1", fence: true },
			{ seqNum: 1, body: body({ type: "user_message", message: "first" }) },
			{
				seqNum: 2,
				body: body({
					type: "error",
					error: { type: "api_error", message: "upstream failed" },
				}),
			},
			{ seqNum: 3, body: "error-1", fence: true, terminalFence: true },
			{ seqNum: 4, body: "holder-2", fence: true },
			{ seqNum: 5, body: body({ type: "user_message", message: "second" }) },
			...textTurn("msg_second", "answer").map((event, index) => ({
				seqNum: 6 + index,
				body: body(event),
			})),
			{ seqNum: 12, body: "end-2", fence: true, terminalFence: true },
		];

		const snapshot = createHistorySnapshot(records);

		expect(snapshot.messages.map((message) => message.id)).toEqual([
			"msg_second",
		]);
		expect(snapshot.turns).toHaveLength(2);
		expect(snapshot.turns[0]).toMatchObject({
			user: "first",
			error: { message: "upstream failed" },
		});
		expect(snapshot.turns[1]?.user).toBe("second");
		expect(snapshot.turns[1]?.assistant?.id).toBe("msg_second");
		expect(snapshot.nextSeqNum).toBe(13);
	});

	it("leaves the cursor at the user record for a live incomplete turn", () => {
		const events = textTurn("msg_live", "partial").slice(0, 3);
		const snapshot = createHistorySnapshot([
			{ seqNum: 0, body: "holder", fence: true },
			{ seqNum: 1, body: body({ type: "user_message", message: "hello" }) },
			...events.map((event, index) => ({
				seqNum: 2 + index,
				body: body(event),
			})),
		]);

		expect(snapshot.turns).toEqual([{ user: "hello" }]);
		expect(snapshot.messages).toEqual([]);
		expect(snapshot.nextSeqNum).toBe(2);
	});

	it("still reconstructs assistant-only streams", () => {
		const snapshot = createHistorySnapshot(
			textTurn("msg_orphan", "orphan").map((event, index) => ({
				seqNum: index,
				body: body(event),
			})),
		);

		expect(snapshot.turns).toEqual([]);
		expect(snapshot.messages.map((message) => message.id)).toEqual([
			"msg_orphan",
		]);
	});
});
