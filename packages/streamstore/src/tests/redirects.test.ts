import { expect, it } from "vitest";
import { S2Error } from "../error.js";
import { S2 } from "../index.js";
import { AppendInput, AppendRecord } from "../types.js";
import {
	cleanupAfterEach,
	serveHttp1,
	serveHttp2,
	withinDeadline,
} from "./helpers.js";

const cleanup = cleanupAfterEach();

it.each(["fetch", "s2s"] as const)(
	"never follows redirects (%s)",
	async (transport) => {
		let redirected = 0;
		const target = await serveHttp1((_req, res) => {
			redirected++;
			res.end("{}");
		});
		cleanup(target.close);
		let requests = 0;
		const location = `${target.origin}/`;
		const server =
			transport === "fetch"
				? await serveHttp1((_req, res) => {
						requests++;
						// Drop the connection mid-body: the 307 must still be reported.
						res.writeHead(307, { location, "content-length": "100" });
						res.write("partial");
						setTimeout(() => res.destroy(), 20);
					})
				: await serveHttp2((stream) => {
						requests++;
						stream.respond({ ":status": 307, location });
						stream.end();
					});
		cleanup(server.close);

		const stream = new S2({
			accessToken: "token",
			endpoints: { account: server.origin, basin: server.origin },
			retry: { maxAttempts: 2, minBaseDelayMillis: 1, maxBaseDelayMillis: 1 },
		})
			.basin("test-basin")
			.stream("stream", { forceTransport: transport });
		cleanup(() => withinDeadline(stream.close()));

		const calls: Array<() => Promise<unknown>> = [
			async () => {
				for await (const _ of await stream.readSession({
					start: { from: { seqNum: 0 } },
				})) {
				}
			},
			async () => {
				const session = await stream.appendSession();
				const ticket = await session.submit(
					AppendInput.create([AppendRecord.string({ body: "a" })]),
				);
				await ticket.ack();
			},
		];
		for (const call of calls) {
			const error = await withinDeadline(call()).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(S2Error);
			expect((error as S2Error).status).toBe(307);
		}
		expect(requests).toBe(calls.length);
		expect(redirected).toBe(0);
	},
);
