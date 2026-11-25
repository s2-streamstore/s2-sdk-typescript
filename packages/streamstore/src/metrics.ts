import type { RetryConfig, S2RequestOptions } from "./common.js";
import { withS2Data } from "./error.js";
import type { Client } from "./generated/client/types.gen.js";
import {
	accountMetrics,
	basinMetrics,
	streamMetrics,
} from "./generated/index.js";
import { toCamelCase, toSnakeCase } from "./internal/case-transform.js";
import { withRetries } from "./lib/retry.js";
import type * as Types from "./types.js";
import { epochMillis } from "./utils.js";

/** Convert timestamp (Date or milliseconds) to Unix seconds (floored). */
function toEpochSeconds(value: number | Date | undefined): number | undefined {
	return value === undefined
		? undefined
		: Math.floor(epochMillis(value) / 1000);
}

/** Convert API metric response to SDK types with Date conversions. */
export function fromAPIMetricSetResponse(
	response: unknown,
): Types.MetricSetResponse {
	const camelCased = toCamelCase<Types.MetricSetResponse>(response);
	const raw = (response as { values: unknown[] }).values;

	// Convert timeseries timestamps from seconds to Date
	return {
		values: camelCased.values.map((metric, i) => {
			if ("accumulation" in metric) {
				return {
					accumulation: {
						...metric.accumulation,
						values: metric.accumulation.values.map(
							([ts, value]) =>
								[new Date((ts as unknown as number) * 1000), value] as [
									Date,
									number,
								],
						),
					},
				};
			}
			if ("gauge" in metric) {
				return {
					gauge: {
						...metric.gauge,
						values: metric.gauge.values.map(
							([ts, value]) =>
								[new Date((ts as unknown as number) * 1000), value] as [
									Date,
									number,
								],
						),
					},
				};
			}
			if ("record" in metric) {
				return {
					record: {
						...metric.record,
						timestamp: new Date(
							(metric.record.timestamp as unknown as number) * 1000,
						),
						// Field names are data, not SDK property names: keep them as sent.
						fields: (raw[i] as { record: { fields: Record<string, string> } })
							.record.fields,
					},
				};
			}
			return metric;
		}),
	};
}

/**
 * Helper for querying account, basin, and stream level metrics.
 *
 * Access via {@link S2.metrics}. Responses are automatically converted to Date-friendly SDK types.
 */
export class S2Metrics {
	readonly client: Client;
	private readonly retryConfig?: RetryConfig;

	constructor(client: Client, retryConfig?: RetryConfig) {
		this.client = client;
		this.retryConfig = retryConfig;
	}

	/**
	 * Account-level metrics.
	 *
	 * @param args.set Metric set to return
	 * @param args.start Optional start timestamp (milliseconds since Unix epoch)
	 * @param args.end Optional end timestamp (milliseconds since Unix epoch)
	 * @param args.interval Optional aggregation interval for timeseries sets
	 * @param args.tokenIds Access token IDs, required for the `token-activity` set
	 */
	public async account(
		args: Types.AccountMetricsInput,
		options?: S2RequestOptions,
	): Promise<Types.MetricSetResponse> {
		const query = {
			set: args.set,
			start: toEpochSeconds(args.start),
			end: toEpochSeconds(args.end),
			interval: args.interval,
			token_id: args.tokenIds ? [...args.tokenIds] : undefined,
		};
		const requestOptions = options ? { ...options } : undefined;
		const response = await withRetries(
			this.retryConfig,
			async () => {
				return await withS2Data(() =>
					accountMetrics({
						client: this.client,
						query,
						...requestOptions,
					}),
				);
			},
			requestOptions?.signal,
		);
		return fromAPIMetricSetResponse(response);
	}

	/**
	 * Basin-level metrics.
	 *
	 * @param args.basin Basin name
	 * @param args.set Metric set to return
	 * @param args.start Optional start timestamp (milliseconds since Unix epoch)
	 * @param args.end Optional end timestamp (milliseconds since Unix epoch)
	 * @param args.interval Optional aggregation interval for timeseries sets
	 */
	public async basin(
		args: Types.BasinMetricsInput,
		options?: S2RequestOptions,
	): Promise<Types.MetricSetResponse> {
		const basin = args.basin;
		const query = toSnakeCase<any>({
			set: args.set,
			start: toEpochSeconds(args.start),
			end: toEpochSeconds(args.end),
			interval: args.interval,
		});
		const requestOptions = options ? { ...options } : undefined;
		const response = await withRetries(
			this.retryConfig,
			async () => {
				return await withS2Data(() =>
					basinMetrics({
						client: this.client,
						path: { basin },
						query,
						...requestOptions,
					}),
				);
			},
			requestOptions?.signal,
		);
		return fromAPIMetricSetResponse(response);
	}

	/**
	 * Stream-level metrics.
	 *
	 * @param args.basin Basin name
	 * @param args.stream Stream name
	 * @param args.set Metric set to return
	 * @param args.start Optional start timestamp (milliseconds since Unix epoch)
	 * @param args.end Optional end timestamp (milliseconds since Unix epoch)
	 * @param args.interval Optional aggregation interval for timeseries sets
	 */
	public async stream(
		args: Types.StreamMetricsInput,
		options?: S2RequestOptions,
	): Promise<Types.MetricSetResponse> {
		const basin = args.basin;
		const stream = args.stream;
		const query = toSnakeCase<any>({
			set: args.set,
			start: toEpochSeconds(args.start),
			end: toEpochSeconds(args.end),
			interval: args.interval,
		});
		const requestOptions = options ? { ...options } : undefined;
		const response = await withRetries(
			this.retryConfig,
			async () => {
				return await withS2Data(() =>
					streamMetrics({
						client: this.client,
						path: { basin, stream },
						query,
						...requestOptions,
					}),
				);
			},
			requestOptions?.signal,
		);
		return fromAPIMetricSetResponse(response);
	}
}
