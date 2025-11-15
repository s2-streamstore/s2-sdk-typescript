import type { DataToObject, RetryConfig, S2RequestOptions } from "./common.js";
import { withS2Data } from "./error.js";
import type { Client } from "./generated/client/types.gen.js";
import {
	type AccountMetricsData,
	accountMetrics,
	type BasinMetricsData,
	basinMetrics,
	type StreamMetricsData,
	streamMetrics,
} from "./generated/index.js";
import { withRetries } from "./lib/retry.js";

export interface AccountMetricsArgs extends DataToObject<AccountMetricsData> {}
export interface BasinMetricsArgs extends DataToObject<BasinMetricsData> {}
export interface StreamMetricsArgs extends DataToObject<StreamMetricsData> {}

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
	public async account(args: AccountMetricsArgs, options?: S2RequestOptions) {
		return await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				accountMetrics({
					client: this.client,
					query: args,
					...options,
				}),
			);
		});
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
	public async basin(args: BasinMetricsArgs, options?: S2RequestOptions) {
		return await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				basinMetrics({
					client: this.client,
					path: args,
					query: args,
					...options,
				}),
			);
		});
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
	public async stream(args: StreamMetricsArgs, options?: S2RequestOptions) {
		return await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				streamMetrics({
					client: this.client,
					path: args,
					query: args,
					...options,
				}),
			);
		});
	}
}
