import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { S2, S2Environment } from "@s2-dev/streamstore";
import { describe, expect, it } from "vitest";

const describeIf = process.env.S2_ACCESS_TOKEN ? describe : describe.skip;

async function within<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timed out")), 5000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function emit(response: ServerResponse, event: Record<string, unknown>): void {
	response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

describeIf("Anthropic example routes", () => {
	it("PR #398: concurrent and resumed turns do not duplicate history", async () => {
		const s2 = new S2(S2Environment.parse());
		const basin = `anthropic-example-${Math.random().toString(36).slice(2, 10)}`;
		const providerResponses: ServerResponse[] = [];
		const provider = createServer((_request, response) => {
			providerResponses.push(response);
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			emit(response, {
				type: "message_start",
				message: {
					id: `message-${providerResponses.length}`,
					type: "message",
					role: "assistant",
					model: "test",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			});
			emit(response, {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			});
			emit(response, {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Hello" },
			});
		});
		provider.listen(0, "127.0.0.1");
		await once(provider, "listening");
		const providerPort = (provider.address() as { port: number }).port;
		await s2.basins.create({
			basin,
			config: { createStreamOnAppend: true, createStreamOnRead: true },
		});
		await expect
			.poll(() => s2.basins.getConfig({ basin }), { timeout: 60_000 })
			.toBeDefined();
		const serverPath = fileURLToPath(
			new URL(
				"../../../../examples/anthropic-resumable-chat/server.ts",
				import.meta.url,
			),
		);
		// The test job has no dist/ output; resolve workspace imports from source.
		const tsconfig = fileURLToPath(
			new URL("../../../../examples/tsconfig.json", import.meta.url),
		);
		const serverArgs = ["run", "--tsconfig-override", tsconfig, serverPath];
		const server = spawn("bun", serverArgs, {
			env: {
				...process.env,
				PORT: "0",
				S2_BASIN: basin,
				ANTHROPIC_API_KEY: "test",
				ANTHROPIC_BASE_URL: `http://127.0.0.1:${providerPort}`,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let diagnostics = "";
		server.stderr.on("data", (chunk) => {
			diagnostics += String(chunk);
		});
		try {
			const url = await within(
				new Promise<string>((resolve, reject) => {
					let output = "";
					server.stdout.on("data", (chunk) => {
						output += String(chunk);
						const match = /http:\/\/localhost:\d+/.exec(output);
						if (match) resolve(match[0]);
					});
					server.once("error", reject);
					server.once("exit", () => reject(new Error(diagnostics)));
				}),
			);
			const post = (message: string) =>
				fetch(`${url}/api/chat`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: "chat", message }),
				});
			const history = () =>
				fetch(`${url}/api/chat/history?id=chat`).then((response) =>
					response.json(),
				);
			const responses = await within(
				Promise.all([post("first"), post("second")]),
			);
			expect(responses.map((response) => response.status).sort()).toEqual([
				202, 409,
			]);
			await Promise.all(responses.map((response) => response.text()));
			const accepted = responses[0]!.status === 202 ? "first" : "second";
			expect((await within(history())).messages).toEqual([
				{ role: "user", content: accepted },
			]);
			const busy = await within(post("still busy"));
			expect(busy.status).toBe(409);
			await busy.text();
			expect((await within(history())).messages).toHaveLength(1);
			await expect
				.poll(() => providerResponses.length, { timeout: 5000 })
				.toBe(1);

			const replay = await within(fetch(`${url}/api/chat/stream?id=chat`));
			expect(replay.status).toBe(200);
			const replayBody = replay.text();
			emit(providerResponses[0]!, {
				type: "error",
				error: { type: "overloaded_error", message: "test failure" },
			});
			providerResponses[0]!.end();
			const text = await within(replayBody);
			expect(text).toContain('"type":"message_start"');
			expect(text).toContain('"type":"error"');

			const next = await within(post("after failure"));
			expect(next.status).toBe(202);
			await next.text();
			expect((await within(history())).messages).toEqual([
				{ role: "user", content: accepted },
				{ role: "user", content: "after failure" },
			]);
			await expect
				.poll(() => providerResponses.length, { timeout: 5000 })
				.toBe(2);
			emit(providerResponses[1]!, { type: "content_block_stop", index: 0 });
			emit(providerResponses[1]!, {
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 1 },
			});
			emit(providerResponses[1]!, { type: "message_stop" });
			// Keep the provider open: the assistant is durable before the terminal fence.
			await expect
				.poll(async () => (await history()).messages.at(-1)?.role, {
					timeout: 5000,
				})
				.toBe("assistant");
			const completedReplay = await within(
				fetch(`${url}/api/chat/stream?id=chat`),
			);
			expect(completedReplay.status).toBe(204);
			await completedReplay.text();
			providerResponses[1]!.end();
		} catch (error) {
			throw new Error(diagnostics || "example route regression", {
				cause: error,
			});
		} finally {
			for (const response of providerResponses) response.end();
			server.kill("SIGTERM");
			await within(once(server, "close")).catch(() => {});
			provider.closeAllConnections();
			provider.close();
			await s2.basins.delete({ basin });
		}
	}, 75_000);
});
