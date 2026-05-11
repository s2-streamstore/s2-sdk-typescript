import type {
	ContentBlock,
	Message,
	MessageDeltaUsage,
	RawMessageStreamEvent,
	Usage,
} from "@anthropic-ai/sdk/resources/messages";

export type Chunk =
	| RawMessageStreamEvent
	| { type: "user_message"; message: string }
	| { type: "error"; error: { type: string; message: string } };

export interface Accumulator {
	push(event: RawMessageStreamEvent): void;
	isDone(): boolean;
	finalMessage(): Message;
	reset(): void;
}

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

function mergeDeltaUsage(base: Usage, delta: MessageDeltaUsage): Usage {
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(delta)) {
		if (value !== null) result[key] = value;
	}
	return result as unknown as Usage;
}

export function createAccumulator(): Accumulator {
	let message: Message | undefined;
	const toolUseJsonBuffers = new Map<number, string>();
	let done = false;

	return {
		push(event: RawMessageStreamEvent): void {
			switch (event.type) {
				case "message_start": {
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
						if (buffer.length === 0) {
							block.input = {};
						} else {
							try {
								block.input = JSON.parse(buffer);
							} catch {}
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
