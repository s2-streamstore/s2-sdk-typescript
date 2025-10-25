import type { DataToObject, S2RequestOptions } from "./common.js";
import { S2Error } from "./error.js";
import {
	type AccountMetricsData,
	accountMetrics,
	type BasinMetricsData,
	basinMetrics,
	type StreamMetricsData,
	streamMetrics,
} from "./generated/index.js";
import type { Client } from "./generated/client/types.gen.js";

export interface AccountMetricsArgs extends DataToObject<AccountMetricsData> {}
export interface BasinMetricsArgs extends DataToObject<BasinMetricsData> {}
export interface StreamMetricsArgs extends DataToObject<StreamMetricsData> {}

export class S2Metrics {
	readonly client: Client;

	constructor(client: Client) {
		this.client = client;
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
		const response = await accountMetrics({
			client: this.client,
			query: args,
			...options,
		});

		if (response.error) {
			throw new S2Error({
				message: response.error.message,
				code: response.error.code ?? undefined,
				status: response.response.status,
			});
		}

		return response.data;
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
		const response = await basinMetrics({
			client: this.client,
			path: args,
			query: args,
			...options,
		});

		if (response.error) {
			throw new S2Error({
				message: response.error.message,
				code: response.error.code ?? undefined,
				status: response.response.status,
			});
		}

		return response.data;
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
		const response = await streamMetrics({
			client: this.client,
			path: args,
			query: args,
			...options,
		});

		if (response.error) {
			throw new S2Error({
				message: response.error.message,
				code: response.error.code ?? undefined,
				status: response.response.status,
			});
		}

		return response.data;
	}
}
