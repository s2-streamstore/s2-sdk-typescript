import { describe, expect, it } from "vitest";
import { S2Error } from "../../error.js";
import { type AppendResult, err, okClose } from "../../lib/result.js";
import { RetryAppendSession } from "../../lib/retry.js";
import { AppendInput, AppendRecord } from "../../types.js";
import { waitFor, withinDeadline } from "../helpers.js";

describe("Issue #135: noSideEffects policy and pipelined non-idempotent requests", () => {
	it("idempotent requests have matchSeqNum set", () => {
		const input = AppendInput.create([AppendRecord.string({ body: "test" })], {
			matchSeqNum: 0,
		});
		expect(input.matchSeqNum).toBe(0);
	});

	it("non-idempotent requests have no matchSeqNum", () => {
		const input = AppendInput.create([AppendRecord.string({ body: "test" })]);
		expect(input.matchSeqNum).toBeUndefined();
	});

	it("hasNoSideEffects returns true for rate_limited errors", () => {
		const error = new S2Error({
			message: "rate limited",
			status: 429,
			code: "rate_limited",
			origin: "server",
		});
		expect(error.hasNoSideEffects()).toBe(true);
	});

	it("hasNoSideEffects returns true for hot_server errors", () => {
		const error = new S2Error({
			message: "hot server",
			status: 502,
			code: "hot_server",
			origin: "server",
		});
		expect(error.hasNoSideEffects()).toBe(true);
	});

	it("does not retry under noSideEffects once a non-idempotent pipelined batch was sent", async () => {
		// Sends every batch, and answers only when told to.
		const answers: Array<(result: AppendResult) => void> = [];
		let sessions = 0;
		const session = await RetryAppendSession.create(
			async () => {
				sessions++;
				return {
					submit: (_input: AppendInput, onSend?: () => void) => {
						onSend?.();
						return new Promise<AppendResult>((resolve) => {
							answers.push(resolve);
						});
					},
					close: async () => okClose(),
				};
			},
			undefined,
			{
				appendRetryPolicy: "noSideEffects",
				minBaseDelayMillis: 1,
				maxBaseDelayMillis: 1,
			},
		);
		const head = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "a" })], {
				matchSeqNum: 0,
			}),
		);
		const pipelined = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "b" })]),
		);
		await waitFor(() => answers.length === 2);

		// The head was not appended, but the pipelined batch may have been.
		answers[0]!(
			err(
				new S2Error({
					message: "rate limited",
					status: 429,
					code: "rate_limited",
					origin: "server",
				}),
			),
		);
		await expect(withinDeadline(head.ack())).rejects.toMatchObject({
			code: "rate_limited",
		});
		await expect(pipelined.ack()).rejects.toMatchObject({
			code: "rate_limited",
		});
		expect(sessions).toBe(1);
	});
});
