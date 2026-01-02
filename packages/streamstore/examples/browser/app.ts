import {
	AppendInput,
	AppendRecord,
	BatchTransform,
	Producer,
	S2,
} from "../../src/index.js";

// Logging utilities
const logEl = document.getElementById("log")!;

function log(
	message: string,
	type: "info" | "success" | "error" | "debug" | "data" = "info",
) {
	const entry = document.createElement("div");
	entry.className = `log-${type}`;
	const ts = new Date().toISOString().slice(11, 23);
	entry.textContent = `[${ts}] ${message}`;
	logEl.appendChild(entry);
	logEl.scrollTop = logEl.scrollHeight;
	console.log(message);
}

// Simple hash for displaying byte content
async function hashBytes(data: Uint8Array): Promise<string> {
	// Double cast needed for TS version compatibility (ArrayBufferLike vs ArrayBuffer)
	const hashBuffer = await crypto.subtle.digest(
		"SHA-256",
		data as unknown as BufferSource,
	);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray
		.slice(0, 8)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// Generate random string data
function randomString(length: number): string {
	const chars =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let result = "";
	for (let i = 0; i < length; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return result;
}

// Generate random byte data
function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

// Get S2 client
function getS2(): {
	s2: S2;
	basin: ReturnType<S2["basin"]>;
	stream: ReturnType<ReturnType<S2["basin"]>["stream"]>;
} | null {
	const accessToken = (
		document.getElementById("accessToken") as HTMLInputElement
	).value.trim();
	const basinName = (
		document.getElementById("basinName") as HTMLInputElement
	).value.trim();
	const streamName = (
		document.getElementById("streamName") as HTMLInputElement
	).value.trim();

	if (!accessToken || !basinName || !streamName) {
		log("Please fill in access token, basin, and stream", "error");
		return null;
	}

	// Save to localStorage
	localStorage.setItem("s2_accessToken", accessToken);
	localStorage.setItem("s2_basinName", basinName);
	localStorage.setItem("s2_streamName", streamName);

	const s2 = new S2({ accessToken });
	const basin = s2.basin(basinName);
	const stream = basin.stream(streamName);

	return { s2, basin, stream };
}

// UI Elements
const accessTokenInput = document.getElementById(
	"accessToken",
) as HTMLInputElement;
const basinNameInput = document.getElementById("basinName") as HTMLInputElement;
const streamNameInput = document.getElementById(
	"streamName",
) as HTMLInputElement;

// Load saved config
accessTokenInput.value = localStorage.getItem("s2_accessToken") || "";
basinNameInput.value = localStorage.getItem("s2_basinName") || "";
streamNameInput.value = localStorage.getItem("s2_streamName") || "";

// Check Tail
document.getElementById("btnCheckTail")!.addEventListener("click", async () => {
	const ctx = getS2();
	if (!ctx) return;

	try {
		log("Checking tail...", "info");
		const result = await ctx.stream.checkTail();
		log(
			`Tail: seqNum=${result.tail.seqNum}, timestamp=${result.tail.timestamp}`,
			"success",
		);
	} catch (err) {
		log(`Error: ${err}`, "error");
	}
});

// Unary Read
document.getElementById("btnReadUnary")!.addEventListener("click", async () => {
	const ctx = getS2();
	if (!ctx) return;

	const seqNum = parseInt(
		(document.getElementById("readSeqNum") as HTMLInputElement).value,
		10,
	);
	const count = parseInt(
		(document.getElementById("readCount") as HTMLInputElement).value,
		10,
	);
	const format = (
		document.querySelector(
			'input[name="readFormat"]:checked',
		) as HTMLInputElement
	).value as "string" | "bytes";

	try {
		log(
			`Unary read: seqNum=${seqNum}, count=${count}, format=${format}`,
			"info",
		);
		const startTime = performance.now();

		const result = await ctx.stream.read(
			{
				start: { from: { seqNum: seqNum } },
				stop: { limits: { count } },
			},
			{ as: format },
		);

		const elapsed = (performance.now() - startTime).toFixed(1);
		log(`Read ${result.records.length} records in ${elapsed}ms`, "success");

		for (const record of result.records) {
			if (format === "bytes") {
				const body = record.body as Uint8Array;
				const hash = await hashBytes(body);
				log(
					`  [${record.seqNum}] len=${body.length}, sha256=${hash}...`,
					"data",
				);
			} else {
				const body = record.body as string;
				const preview = body.length > 80 ? body.slice(0, 80) + "..." : body;
				log(`  [${record.seqNum}] ${preview}`, "data");
			}
		}
	} catch (err) {
		log(`Error: ${err}`, "error");
	}
});

// Read Session
let activeReadSession: ReadableStreamDefaultReader<any> | null = null;

document
	.getElementById("btnReadSession")!
	.addEventListener("click", async () => {
		const ctx = getS2();
		if (!ctx) return;

		const seqNum = parseInt(
			(document.getElementById("readSeqNum") as HTMLInputElement).value,
			10,
		);
		const count = parseInt(
			(document.getElementById("readCount") as HTMLInputElement).value,
			10,
		);
		const format = (
			document.querySelector(
				'input[name="readFormat"]:checked',
			) as HTMLInputElement
		).value as "string" | "bytes";

		const btnStart = document.getElementById(
			"btnReadSession",
		) as HTMLButtonElement;
		const btnStop = document.getElementById(
			"btnStopReadSession",
		) as HTMLButtonElement;

		try {
			log(
				`Starting read session: seqNum=${seqNum}, count=${count}, format=${format}`,
				"info",
			);
			btnStart.disabled = true;
			btnStop.disabled = false;

			const session = await ctx.stream.readSession(
				{
					start: { from: { seqNum: seqNum } },
					stop: { limits: { count } },
				},
				{ as: format },
			);
			activeReadSession = session.getReader();

			let recordCount = 0;
			const startTime = performance.now();

			while (true) {
				const { done, value: record } = await activeReadSession.read();
				if (done) break;

				recordCount++;
				if (format === "bytes") {
					const body = record.body as Uint8Array;
					const hash = await hashBytes(body);
					log(
						`  [${record.seqNum}] len=${body.length}, sha256=${hash}...`,
						"data",
					);
				} else {
					const body = record.body as string;
					const preview = body.length > 80 ? body.slice(0, 80) + "..." : body;
					log(`  [${record.seqNum}] ${preview}`, "data");
				}
			}

			const elapsed = (performance.now() - startTime).toFixed(1);
			log(
				`Read session complete: ${recordCount} records in ${elapsed}ms`,
				"success",
			);
		} catch (err) {
			if (
				String(err).includes("cancelled") ||
				String(err).includes("aborted")
			) {
				log("Read session stopped", "info");
			} else {
				log(`Error: ${err}`, "error");
			}
		} finally {
			activeReadSession = null;
			btnStart.disabled = false;
			btnStop.disabled = true;
		}
	});

document
	.getElementById("btnStopReadSession")!
	.addEventListener("click", async () => {
		if (activeReadSession) {
			log("Stopping read session...", "info");
			try {
				await activeReadSession.cancel("user stopped");
			} catch {}
		}
	});

// Append Session
document
	.getElementById("btnAppendSession")!
	.addEventListener("click", async () => {
		const ctx = getS2();
		if (!ctx) return;

		const count = parseInt(
			(document.getElementById("appendCount") as HTMLInputElement).value,
			10,
		);
		const size = parseInt(
			(document.getElementById("appendSize") as HTMLInputElement).value,
			10,
		);
		const format = (
			document.querySelector(
				'input[name="appendFormat"]:checked',
			) as HTMLInputElement
		).value;

		const btn = document.getElementById(
			"btnAppendSession",
		) as HTMLButtonElement;

		try {
			log(
				`Starting append session: ${count} records, ${size} bytes each, format=${format}`,
				"info",
			);
			btn.disabled = true;

			const session = await ctx.stream.appendSession();
			const startTime = performance.now();

			const tickets = [];
			for (let i = 0; i < count; i++) {
				let ticket;
				if (format === "bytes") {
					ticket = await session.submit(
						AppendInput.create([
							AppendRecord.bytes({ body: randomBytes(size) }),
						]),
					);
				} else {
					ticket = await session.submit(
						AppendInput.create([
							AppendRecord.string({
								body: `[${i}] ${randomString(size - 10)}`,
							}),
						]),
					);
				}
				tickets.push({ i, ticket });
			}

			log(`Submitted ${count} records, waiting for acks...`, "info");

			for (const { i, ticket } of tickets) {
				const ack = await ticket.ack();
				if (i === 0 || i === count - 1 || count <= 10) {
					log(
						`  [${i}] ack: seqNum=${ack.start.seqNum}-${ack.end.seqNum}`,
						"data",
					);
				} else if (i === 1 && count > 10) {
					log(`  ... (${count - 2} more) ...`, "debug");
				}
			}

			await session.close();

			const elapsed = (performance.now() - startTime).toFixed(1);
			const throughput = (
				(count * size) /
				1024 /
				(parseFloat(elapsed) / 1000)
			).toFixed(1);
			log(
				`Append session complete: ${count} records in ${elapsed}ms (${throughput} KB/s)`,
				"success",
			);
		} catch (err) {
			log(`Error: ${err}`, "error");
		} finally {
			btn.disabled = false;
		}
	});

// Producer
document.getElementById("btnProducer")!.addEventListener("click", async () => {
	const ctx = getS2();
	if (!ctx) return;

	const count = parseInt(
		(document.getElementById("producerCount") as HTMLInputElement).value,
		10,
	);
	const size = parseInt(
		(document.getElementById("producerSize") as HTMLInputElement).value,
		10,
	);
	const linger = parseInt(
		(document.getElementById("producerLinger") as HTMLInputElement).value,
		10,
	);
	const maxRecords = parseInt(
		(document.getElementById("producerMaxRecords") as HTMLInputElement).value,
		10,
	);
	const format = (
		document.querySelector(
			'input[name="producerFormat"]:checked',
		) as HTMLInputElement
	).value;

	const btn = document.getElementById("btnProducer") as HTMLButtonElement;

	try {
		log(
			`Starting producer: ${count} records, ${size} bytes each, linger=${linger}ms, maxBatch=${maxRecords}, format=${format}`,
			"info",
		);
		btn.disabled = true;

		const session = await ctx.stream.appendSession();
		const batchTransform = new BatchTransform({
			lingerDurationMillis: linger,
			maxBatchRecords: maxRecords,
		});
		const producer = new Producer(batchTransform, session);

		const startTime = performance.now();
		let ackedCount = 0;
		let firstSeqNum: number | null = null;
		let lastSeqNum: number | null = null;

		const tickets = [];
		for (let i = 0; i < count; i++) {
			let ticket;
			if (format === "bytes") {
				ticket = await producer.submit(
					AppendRecord.bytes({ body: randomBytes(size) }),
				);
			} else {
				ticket = await producer.submit(
					AppendRecord.string({
						body: `[${i}] ${randomString(Math.max(0, size - 10))}`,
					}),
				);
			}
			tickets.push(ticket);
		}

		log(`Submitted ${count} records to producer, waiting for acks...`, "info");

		for (const ticket of tickets) {
			const indexedAck = await ticket.ack();
			ackedCount++;
			const seqNum = indexedAck.seqNum();
			if (firstSeqNum === null) firstSeqNum = seqNum;
			lastSeqNum = seqNum;
		}

		await producer.close();

		const elapsed = (performance.now() - startTime).toFixed(1);
		const throughput = (
			(count * size) /
			1024 /
			(parseFloat(elapsed) / 1000)
		).toFixed(1);
		log(
			`Producer complete: ${ackedCount} records in ${elapsed}ms (${throughput} KB/s), seqNum=${firstSeqNum}-${lastSeqNum}`,
			"success",
		);
	} catch (err) {
		log(`Error: ${err}`, "error");
	} finally {
		btn.disabled = false;
	}
});

// Clear log
document.getElementById("btnClear")!.addEventListener("click", () => {
	logEl.innerHTML = "";
});

log("S2 SDK Browser Test ready", "info");
