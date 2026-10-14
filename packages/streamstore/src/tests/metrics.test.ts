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
