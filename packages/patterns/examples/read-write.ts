import { createHash } from "node:crypto";
import { decode, encode } from "@msgpack/msgpack";
import { S2 } from "@s2-dev/streamstore";
import createDebug from "debug";
import {
	DeserializingReadSession,
	SerializingAppendSession,
} from "../src/patterns/serialization.js";

const debug = createDebug("patterns:examples:read-write");

type MultimodalMessage =
	| { type: "text"; message: string }
	| { type: "code"; code: string }
	| { type: "image"; imageBytes: Uint8Array };

type ChatMessage = { userId: string; message: MultimodalMessage };

function randomBytes(size: number): Uint8Array {
	const buf = new Uint8Array(size);
	const maxChunk = 65536;

	for (let offset = 0; offset < size; offset += maxChunk) {
		const end = Math.min(offset + maxChunk, size);
		crypto.getRandomValues(buf.subarray(offset, end));
	}

	return buf;
}

function computeChecksum(message: ChatMessage): string {
	const hash = createHash("sha256");
	const bytes = encode(message);
	hash.update(bytes);
	return hash.digest("base64");
}

function randomChatMessage(): ChatMessage {
	const randomUserId = `user_${Math.floor(Math.random() * 1000)}`;

	const types = ["text", "code", "image"] as const;
	const selectedType = types[Math.floor(Math.random() * types.length)];

	let message: MultimodalMessage;

	switch (selectedType) {
		case "text":
			message = {
				type: "text",
				message: `Random text ${Math.random().toString(36).slice(2, 8)}`,
			};
			break;

		case "code":
			message = {
				type: "code",
				code: `console.log("Random code ${Math.random()}");`,
			};
			break;

		case "image": {
			const size = 5 * 1024 * 1024; // 5 MiB
			const imageBytes = randomBytes(size);
			message = {
				type: "image",
				imageBytes,
			};
			break;
		}

		default:
			throw new Error("Unexpected message type");
	}

	return { userId: randomUserId, message };
}

const s2 = new S2({
	accessToken: process.env.S2_ACCESS_TOKEN!,
	retry: {
		maxAttempts: 10,
		retryBackoffDurationMillis: 100,
		requestTimeoutMillis: 10000,
		appendRetryPolicy: "all",
	},
});

const basinId = process.env.S2_BASIN ?? "my-test-basin";
const streamId = process.env.S2_STREAM ?? "read-write";

const stream = s2.basin(basinId).stream(streamId);

const appender = new SerializingAppendSession<ChatMessage>(
	await stream.appendSession({ maxInflightBatches: 10 }),
	(msg) => encode(msg),
	{ dedupeSeq: 0n },
);

const reader = new DeserializingReadSession<ChatMessage>(
	await stream.readSession({ tail_offset: 0, as: "bytes" }),
	(buf) => decode(buf) as ChatMessage,
	{ enableDedupe: true },
).getReader();

// Write 100 messages, and read them back.
for (let i = 0; i < 100; i++) {
	// Generate a random message.
	const message = randomChatMessage();
	const writeChecksum = computeChecksum(message);
	const messageType = message.message.type;

	debug("write start", { messageType });
	// Submit the message to the append session, and block until it is durable.
	const ackRange = await appender.submit(message);
	debug("write end", { ackRange });

	debug("read start");
	// Read the corresponding message from the stream.
	let { done, value } = await reader.read();
	debug("read end");
	if (done) {
		throw new Error("Read session closed unexpectedly.");
	}

	const readChecksum = computeChecksum(value!);

	if (writeChecksum !== readChecksum) {
		throw new Error(`Checksum mismatch: ${writeChecksum} !== ${readChecksum}`);
	}

	console.log({ writeChecksum, readChecksum });
}
