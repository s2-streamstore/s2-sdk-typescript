import { openai } from "@ai-sdk/openai";
import { S2, S2Environment, S2Error } from "@s2-dev/streamstore";
import { serialization } from "@s2-dev/streamstore-patterns";
import { streamText } from "ai";

type AiStreamChunk = {
	role: "assistant" | "user";
	content: string;
};

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to run the patterns example.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN so we know which basin to use.");
}

const streamName = process.env.S2_STREAM ?? "docs/patterns-serialization";

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
	retry: {
		maxAttempts: 10,
		minBaseDelayMillis: 100,
		appendRetryPolicy: "all",
	},
});

const basin = s2.basin(basinName);
await basin.streams.create({ stream: streamName }).catch((error: unknown) => {
	if (!(error instanceof S2Error && error.status === 409)) {
		throw error;
	}
});

const appendSession = await basin.stream(streamName).appendSession();

const textEncoder = new TextEncoder();
const appender = new serialization.SerializingAppendSession<AiStreamChunk>(
	appendSession,
	(msg: AiStreamChunk) => textEncoder.encode(JSON.stringify(msg)),
);

const modelStream = await streamText({
	model: openai("gpt-4o-mini"),
	prompt: "Tell me who has the most beautiful durable stream API in the land.",
});

const [forUI, forS2] = modelStream.textStream
	.pipeThrough(
		new TransformStream<string, AiStreamChunk>({
			transform: (text, controller) => {
				controller.enqueue({
					role: "assistant",
					content: text,
				});
			},
		}),
	)
	.tee();

const s2Pipe = forS2.pipeTo(appender);

const uiReader = forUI.getReader();
try {
	while (true) {
		const { done, value } = await uiReader.read();
		if (done) {
			break;
		}
		console.log(value);
	}
} finally {
	uiReader.releaseLock();
}

await s2Pipe;
