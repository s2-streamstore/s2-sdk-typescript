import { describe, expect, it, vi } from "vitest";
import {
	type API,
	type MetricSetResponse,
	S2,
	type TimeseriesInterval,
} from "../index.js";

describe("estimated billable usage metrics", () => {
	it.each([undefined, "hour", "day"] as const)(
		"supports interval %s and preserves fractional USD values",
		async (interval: TimeseriesInterval | undefined) => {
			const start = new Date("2026-10-01T00:00:00Z");
			const end = new Date("2026-10-03T00:00:00Z");
			const timestamp = start.getTime() / 1000;
			const response = {
				values: ["transfer.writes_standard", "total"].map((name) => ({
					accumulation: {
						name,
						unit: "usd",
						interval: interval ?? "hour",
						values: [[timestamp, 0.012345]],
					},
				})),
			} satisfies API.MetricSetResponse;
			const fetchMock = vi.fn(async (_request: Request) =>
				Response.json(response),
			);
			const s2 = new S2({ accessToken: "test-token" });
			s2.metrics.client.setConfig({
				fetch: fetchMock as unknown as typeof fetch,
			});

			const result = await s2.metrics.account({
				set: "estimated-billable-usage",
				start,
				end: end.getTime(),
				interval,
			});

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const request = fetchMock.mock.calls[0]![0];
			const url = new URL(request.url);
			expect(request.method).toBe("GET");
			expect(url.pathname).toBe("/v1/metrics");
			expect(Object.fromEntries(url.searchParams)).toEqual({
				set: "estimated-billable-usage",
				start: String(timestamp),
				end: String(end.getTime() / 1000),
				...(interval === undefined ? {} : { interval }),
			});
			expect(result).toEqual({
				values: response.values.map((metric) => ({
					accumulation: {
						...metric.accumulation,
						values: [[start, 0.012345]],
					},
				})),
			} satisfies MetricSetResponse);
		},
	);
});

describe("token activity metrics", () => {
	it("repeats token_id and keeps record field names as sent", async () => {
		const response = {
			values: [
				{
					record: {
						name: "tok-a",
						timestamp: 1790000000,
						fields: { outcome: "success", user_agent: "s2-cli" },
					},
				},
			],
		} satisfies API.MetricSetResponse;
		const fetchMock = vi.fn(async (_request: Request) =>
			Response.json(response),
		);
		const s2 = new S2({ accessToken: "test-token" });
		s2.metrics.client.setConfig({
			fetch: fetchMock as unknown as typeof fetch,
		});

		const result = await s2.metrics.account({
			set: "token-activity",
			tokenIds: ["tok-a", "tok-b"],
		});

		const url = new URL(fetchMock.mock.calls[0]![0].url);
		expect(url.search).toBe(
			"?set=token-activity&token_id=tok-a&token_id=tok-b",
		);
		expect(result).toEqual({
			values: [
				{
					record: {
						name: "tok-a",
						timestamp: new Date(1790000000 * 1000),
						fields: { outcome: "success", user_agent: "s2-cli" },
					},
				},
			],
		} satisfies MetricSetResponse);
	});
});
