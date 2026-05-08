import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import { describe, expect, it } from "vitest";
import {
	accumulateMessage,
	createAnthropicAccumulator,
} from "../anthropic-accumulator.js";

// Synthetic event traces modelled on the wire format documented at
// https://platform.claude.com/docs/en/api/messages-streaming. The accumulator
// is a deterministic state machine on these events, so synthetic traces are
// sufficient — no live API call required.

const baseUsage = {
	input_tokens: 25,
	output_tokens: 1,
	cache_creation_input_tokens: 0,
	cache_read_input_tokens: 0,
};

function textTurn(text: string): RawMessageStreamEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_001",
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
			content_block: { type: "text", text: "", citations: null },
		} as unknown as RawMessageStreamEvent,
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		} as unknown as RawMessageStreamEvent,
		{
			type: "content_block_stop",
			index: 0,
		} as RawMessageStreamEvent,
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 15 },
		} as unknown as RawMessageStreamEvent,
		{ type: "message_stop" } as RawMessageStreamEvent,
	];
}

describe("anthropic accumulator", () => {
	it("reconstructs a text-only turn", () => {
		const message = accumulateMessage(textTurn("Hello, world!"));
		expect(message.id).toBe("msg_001");
		expect(message.role).toBe("assistant");
		expect(message.content).toHaveLength(1);
		const block = message.content[0];
		expect(block?.type).toBe("text");
		if (block?.type === "text") {
			expect(block.text).toBe("Hello, world!");
		}
		expect(message.stop_reason).toBe("end_turn");
		// `output_tokens` from message_delta overwrites; `input_tokens` from
		// message_start survives because message_delta usage is partial.
		expect(message.usage.input_tokens).toBe(25);
		expect(message.usage.output_tokens).toBe(15);
	});

	it("concatenates split text deltas", () => {
		const events: RawMessageStreamEvent[] = [
			...textTurn("ignored").slice(0, 2),
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Hel" },
			} as unknown as RawMessageStreamEvent,
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "lo " },
			} as unknown as RawMessageStreamEvent,
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "world" },
			} as unknown as RawMessageStreamEvent,
			{ type: "content_block_stop", index: 0 } as RawMessageStreamEvent,
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 3 },
			} as unknown as RawMessageStreamEvent,
			{ type: "message_stop" } as RawMessageStreamEvent,
		];
		const message = accumulateMessage(events);
		expect(message.content[0]?.type).toBe("text");
		if (message.content[0]?.type === "text") {
			expect(message.content[0].text).toBe("Hello world");
		}
	});

	it("reconstructs a tool_use turn from input_json_delta partials", () => {
		const events: RawMessageStreamEvent[] = [
			{
				type: "message_start",
				message: {
					id: "msg_002",
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
					id: "toolu_01",
					name: "get_weather",
					input: {},
				},
			} as unknown as RawMessageStreamEvent,
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"location":' },
			} as unknown as RawMessageStreamEvent,
			{
				type: "content_block_delta",
				index: 0,
				delta: {
					type: "input_json_delta",
					partial_json: ' "San Francisco, CA"',
				},
			} as unknown as RawMessageStreamEvent,
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: "}" },
			} as unknown as RawMessageStreamEvent,
			{ type: "content_block_stop", index: 0 } as RawMessageStreamEvent,
			{
				type: "message_delta",
				delta: { stop_reason: "tool_use", stop_sequence: null },
				usage: { output_tokens: 89 },
			} as unknown as RawMessageStreamEvent,
			{ type: "message_stop" } as RawMessageStreamEvent,
		];
		const message = accumulateMessage(events);
		const block = message.content[0];
		expect(block?.type).toBe("tool_use");
		if (block?.type === "tool_use") {
			expect(block.id).toBe("toolu_01");
			expect(block.name).toBe("get_weather");
			expect(block.input).toEqual({ location: "San Francisco, CA" });
		}
		expect(message.stop_reason).toBe("tool_use");
	});

	it("reconstructs a thinking block with signature", () => {
		const events: RawMessageStreamEvent[] = [
			{
				type: "message_start",
				message: {
					id: "msg_003",
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
				content_block: { type: "thinking", thinking: "", signature: "" },
			} as unknown as RawMessageStreamEvent,
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: "Let me think... " },
			} as unknown as RawMessageStreamEvent,
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: "the answer is 42." },
			} as unknown as RawMessageStreamEvent,
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "signature_delta", signature: "sig_abc123" },
			} as unknown as RawMessageStreamEvent,
			{ type: "content_block_stop", index: 0 } as RawMessageStreamEvent,
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 10 },
			} as unknown as RawMessageStreamEvent,
			{ type: "message_stop" } as RawMessageStreamEvent,
		];
		const message = accumulateMessage(events);
		const block = message.content[0];
		expect(block?.type).toBe("thinking");
		if (block?.type === "thinking") {
			expect(block.thinking).toBe("Let me think... the answer is 42.");
			expect(block.signature).toBe("sig_abc123");
		}
	});

	it("handles multiple content blocks (text + tool_use)", () => {
		const events: RawMessageStreamEvent[] = [
			{
				type: "message_start",
				message: {
					id: "msg_004",
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
				delta: { type: "text_delta", text: "Looking up..." },
			} as unknown as RawMessageStreamEvent,
			{ type: "content_block_stop", index: 0 } as RawMessageStreamEvent,
			{
				type: "content_block_start",
				index: 1,
				content_block: {
					type: "tool_use",
					id: "toolu_02",
					name: "search",
					input: {},
				},
			} as unknown as RawMessageStreamEvent,
			{
				type: "content_block_delta",
				index: 1,
				delta: { type: "input_json_delta", partial_json: '{"q":"weather"}' },
			} as unknown as RawMessageStreamEvent,
			{ type: "content_block_stop", index: 1 } as RawMessageStreamEvent,
			{
				type: "message_delta",
				delta: { stop_reason: "tool_use", stop_sequence: null },
				usage: { output_tokens: 12 },
			} as unknown as RawMessageStreamEvent,
			{ type: "message_stop" } as RawMessageStreamEvent,
		];
		const message = accumulateMessage(events);
		expect(message.content).toHaveLength(2);
		expect(message.content[0]?.type).toBe("text");
		expect(message.content[1]?.type).toBe("tool_use");
		if (message.content[1]?.type === "tool_use") {
			expect(message.content[1].input).toEqual({ q: "weather" });
		}
	});

	it("throws if finalMessage is called before message_start", () => {
		const acc = createAnthropicAccumulator();
		expect(() => acc.finalMessage()).toThrow(/before message_start/);
	});

	it("throws if finalMessage is called before message_stop", () => {
		const acc = createAnthropicAccumulator();
		for (const event of textTurn("partial").slice(0, -1)) acc.push(event);
		expect(acc.isDone()).toBe(false);
		expect(() => acc.finalMessage()).toThrow(/before message_stop/);
	});

	it("reset clears state and allows a fresh turn", () => {
		const acc = createAnthropicAccumulator();
		for (const event of textTurn("first")) acc.push(event);
		const first = acc.finalMessage();
		expect(first.id).toBe("msg_001");

		acc.reset();
		expect(acc.isDone()).toBe(false);

		const second: RawMessageStreamEvent[] = textTurn("second").map((e) =>
			e.type === "message_start"
				? ({
						...e,
						message: { ...e.message, id: "msg_005" },
					} as RawMessageStreamEvent)
				: e,
		);
		for (const event of second) acc.push(event);
		const out = acc.finalMessage();
		expect(out.id).toBe("msg_005");
		if (out.content[0]?.type === "text") {
			expect(out.content[0].text).toBe("second");
		}
	});

	it("ignores content_block_delta events when no message_start has been seen", () => {
		const acc = createAnthropicAccumulator();
		// Should not throw; should silently skip.
		acc.push({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "leak" },
		} as unknown as RawMessageStreamEvent);
		expect(acc.isDone()).toBe(false);
	});

	it("preserves input_tokens from message_start across message_delta usage merge", () => {
		const message = accumulateMessage(textTurn("hi"));
		expect(message.usage.input_tokens).toBe(25);
		// message_delta carried usage: { output_tokens: 15 } only — input_tokens
		// must not get clobbered to null even though MessageDeltaUsage allows null.
	});
});
