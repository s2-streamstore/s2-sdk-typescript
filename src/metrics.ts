import type { DataToObject, S2RequestOptions } from "./common";
import { S2Error } from "./error";
import {
	type AccountMetricsData,
	accountMetrics,
	type BasinMetricsData,
	basinMetrics,
	type StreamMetricsData,
	streamMetrics,
} from "./generated";
import type { Client } from "./generated/client/types.gen";

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
	public async account(
		args: DataToObject<AccountMetricsData>,
		options?: S2RequestOptions,
	) {
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
	public async basin(
		args: DataToObject<BasinMetricsData>,
		options?: S2RequestOptions,
	) {
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
	public async stream(
		args: DataToObject<StreamMetricsData>,
		options?: S2RequestOptions,
	) {
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
