/**
 * Walks `RawMessageStreamEvent`s and rebuilds the final `Message`.
 *
 * The `@anthropic-ai/sdk` SDK accumulates messages internally inside its
 * `MessageStream` class, but the accumulator is private and only callable via
 * `MessageStream.fromReadableStream` (which expects the SDK's own framing —
 * not the standard SSE wire format we store). So we re-implement the small
 * deterministic walker here. Reused on both server (`history()`) and client
 * (`subscribe()`).
 *
 * Source of truth for the state machine:
 *   https://platform.claude.com/docs/en/api/messages-streaming
 */
import type {
	ContentBlock,
	Message,
	MessageDeltaUsage,
	RawMessageStreamEvent,
	Usage,
} from "@anthropic-ai/sdk/resources/messages";

/**
 * Anthropic SSE chunk type: `RawMessageStreamEvent` (the union of
 * message_start / content_block_* / message_delta / message_stop) plus the
 * wire-level `error` event the API can emit, which the SDK doesn't include
 * in `RawMessageStreamEvent`.
 */
export type Chunk =
	| RawMessageStreamEvent
	| { type: "error"; error: { type: string; message: string } };

export interface Accumulator {
	push(event: RawMessageStreamEvent): void;
	isDone(): boolean;
	finalMessage(): Message;
	reset(): void;
}

/** One-shot accumulation: feed a turn's events, get the final `Message`. */
export function accumulateMessage(
	events: Iterable<RawMessageStreamEvent>,
): Message {
	const acc = createAccumulator();
	for (const event of events) acc.push(event);
	return acc.finalMessage();
}

const RAW_MESSAGE_EVENT_TYPES = new Set<RawMessageStreamEvent["type"]>([
	"message_start",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
	"message_delta",
	"message_stop",
]);

/**
 * Streaming accumulation: yield one `Message` per turn that ends with
 * `message_stop`. Events outside the `RawMessageStreamEvent` union (e.g.
 * wire-level `error` events) are skipped, so callers can pipe a subscription's
 * mixed event stream straight in.
 */
export async function* messagesFromEvents(
	events: AsyncIterable<{ type: string }>,
): AsyncIterable<Message> {
	const acc = createAccumulator();
	for await (const event of events) {
		if (
			!RAW_MESSAGE_EVENT_TYPES.has(event.type as RawMessageStreamEvent["type"])
		)
			continue;
		acc.push(event as RawMessageStreamEvent);
		if (event.type === "message_stop") {
			yield acc.finalMessage();
			acc.reset();
		}
	}
}

/**
 * Merge a `MessageDeltaUsage` (which can carry nullable fields) into an
 * existing `Usage`, dropping nulls so the message's `Usage` invariants
 * survive. Cast is sound because the only fields we copy from `delta` are
 * non-null and match `Usage`'s shape, but TS can't see that.
 */
function mergeDeltaUsage(base: Usage, delta: MessageDeltaUsage): Usage {
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(delta)) {
		if (value !== null) result[key] = value;
	}
	return result as unknown as Usage;
}

/** Stateful accumulator. `finalMessage()` is only valid after `message_stop`. */
export function createAccumulator(): Accumulator {
	let message: Message | undefined;
	const toolUseJsonBuffers = new Map<number, string>();
	let done = false;

	return {
		push(event: RawMessageStreamEvent): void {
			switch (event.type) {
				case "message_start": {
					// Clone so we don't mutate the caller's event payload.
					message = {
						...event.message,
						content: [],
					};
					toolUseJsonBuffers.clear();
					done = false;
					return;
				}
				case "content_block_start": {
					if (!message) return;
					message.content[event.index] = {
						...event.content_block,
					} as ContentBlock;
					if (
						event.content_block.type === "tool_use" ||
						event.content_block.type === "server_tool_use"
					) {
						toolUseJsonBuffers.set(event.index, "");
					}
					return;
				}
				case "content_block_delta": {
					if (!message) return;
					const block = message.content[event.index] as
						| ContentBlock
						| undefined;
					if (!block) return;
					const delta = event.delta;
					if (delta.type === "text_delta" && block.type === "text") {
						block.text += delta.text;
						return;
					}
					if (delta.type === "input_json_delta") {
						const buffer = toolUseJsonBuffers.get(event.index) ?? "";
						toolUseJsonBuffers.set(event.index, buffer + delta.partial_json);
						return;
					}
					if (delta.type === "thinking_delta" && block.type === "thinking") {
						block.thinking += delta.thinking;
						return;
					}
					if (delta.type === "signature_delta" && block.type === "thinking") {
						block.signature = delta.signature;
						return;
					}
					if (delta.type === "citations_delta" && block.type === "text") {
						const citations = block.citations ?? [];
						citations.push(delta.citation);
						block.citations = citations;
						return;
					}
					return;
				}
				case "content_block_stop": {
					if (!message) return;
					const buffer = toolUseJsonBuffers.get(event.index);
					if (buffer === undefined) return;
					const block = message.content[event.index];
					if (block?.type === "tool_use" || block?.type === "server_tool_use") {
						try {
							block.input = buffer.length > 0 ? JSON.parse(buffer) : {};
						} catch {
							// Leave block.input as whatever the SDK initialized it to
							// (typically `{}`); a malformed partial_json stream is a
							// real bug in the source, not something to recover from.
						}
					}
					toolUseJsonBuffers.delete(event.index);
					return;
				}
				case "message_delta": {
					if (!message) return;
					if (event.delta.stop_reason !== undefined) {
						message.stop_reason = event.delta.stop_reason;
					}
					if (event.delta.stop_sequence !== undefined) {
						message.stop_sequence = event.delta.stop_sequence;
					}
					if (
						"container" in event.delta &&
						event.delta.container !== undefined
					) {
						message.container = event.delta.container;
					}
					if (
						"stop_details" in event.delta &&
						event.delta.stop_details !== undefined
					) {
						message.stop_details = event.delta.stop_details;
					}
					if (event.usage) {
						// `MessageDeltaUsage` carries cumulative output_tokens; merge
						// rather than replace so input_tokens from message_start survive.
						message.usage = mergeDeltaUsage(message.usage, event.usage);
					}
					return;
				}
				case "message_stop": {
					done = true;
					return;
				}
			}
		},
		isDone(): boolean {
			return done;
		},
		finalMessage(): Message {
			if (!message) throw new Error("finalMessage called before message_start");
			if (!done) throw new Error("finalMessage called before message_stop");
			return message;
		},
		reset(): void {
			message = undefined;
			toolUseJsonBuffers.clear();
			done = false;
		},
	};
}
