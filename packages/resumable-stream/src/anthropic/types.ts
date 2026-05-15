import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";

/** Anthropic events, plus the error envelope the adapter writes when a source throws. */
export type Chunk =
	| RawMessageStreamEvent
	| { type: "error"; error: { type: string; message: string } };
