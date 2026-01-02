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
	 * @param args.start Optional start timestamp (Unix seconds)
	 * @param args.end Optional end timestamp (Unix seconds)
	 * @param args.interval Optional aggregation interval for timeseries sets
	 */
	public async account(
		args: Types.AccountMetricsInput,
		options?: S2RequestOptions,
	): Promise<Types.MetricSetResponse> {
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				accountMetrics({
					client: this.client,
					query: toSnakeCase(args),
					...options,
				}),
			);
		});
		return toCamelCase<Types.MetricSetResponse>(response);
	}

	/**
	 * Basin-level metrics.
	 *
	 * @param args.basin Basin name
	 * @param args.set Metric set to return
	 * @param args.start Optional start timestamp (Unix seconds)
	 * @param args.end Optional end timestamp (Unix seconds)
	 * @param args.interval Optional aggregation interval for timeseries sets
	 */
	public async basin(
		args: Types.BasinMetricsInput,
		options?: S2RequestOptions,
	): Promise<Types.MetricSetResponse> {
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				basinMetrics({
					client: this.client,
					path: args,
					query: toSnakeCase(args),
					...options,
				}),
			);
		});
		return toCamelCase<Types.MetricSetResponse>(response);
	}

	/**
	 * Stream-level metrics.
	 *
	 * @param args.basin Basin name
	 * @param args.stream Stream name
	 * @param args.set Metric set to return
	 * @param args.start Optional start timestamp (Unix seconds)
	 * @param args.end Optional end timestamp (Unix seconds)
	 * @param args.interval Optional aggregation interval for timeseries sets
	 */
	public async stream(
		args: Types.StreamMetricsInput,
		options?: S2RequestOptions,
	): Promise<Types.MetricSetResponse> {
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				streamMetrics({
					client: this.client,
					path: args,
					query: toSnakeCase(args),
					...options,
				}),
			);
		});
		return toCamelCase<Types.MetricSetResponse>(response);
	}
}
