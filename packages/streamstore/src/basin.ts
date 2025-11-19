import type { RetryConfig } from "./common.js";
import { createClient, createConfig } from "./generated/client/index.js";
import type { Client } from "./generated/client/types.gen.js";
import * as Redacted from "./lib/redacted.js";
import {
	canSetUserAgentHeader,
	DEFAULT_USER_AGENT,
} from "./lib/stream/runtime.js";
import type { SessionTransports, TransportConfig } from "./lib/stream/types.js";
import { S2Stream } from "./stream.js";
import { S2Streams } from "./streams.js";

export class S2Basin {
	private readonly client: Client;
	private readonly transportConfig: TransportConfig;
	private readonly retryConfig?: RetryConfig;
	public readonly name: string;
	public readonly streams: S2Streams;

	/**
	 * Create a basin-scoped client that talks to `https://{basin}.b.aws.s2.dev/v1`.
	 *
	 * Use this to work with streams inside a single basin.
	 * @param name Basin name
	 * @param options Configuration for the basin-scoped client
	 */
	constructor(
		name: string,
		options: {
			accessToken: Redacted.Redacted;
			baseUrl: string;
			includeBasinHeader: boolean;
			retryConfig?: RetryConfig;
		},
	) {
		this.name = name;
		this.retryConfig = options.retryConfig;
		this.transportConfig = {
			baseUrl: options.baseUrl,
			accessToken: options.accessToken,
			basinName: options.includeBasinHeader ? name : undefined,
			retry: options.retryConfig,
		};
		const headers: Record<string, string> = {};
		if (options.includeBasinHeader) {
			headers["s2-basin"] = name;
		}
		if (canSetUserAgentHeader()) {
			headers["user-agent"] = DEFAULT_USER_AGENT;
		}
		this.client = createClient(
			createConfig({
				baseUrl: options.baseUrl,
				auth: () => Redacted.value(this.transportConfig.accessToken),
				headers: headers,
			}),
		);

		this.streams = new S2Streams(this.client, this.retryConfig);
	}

	/**
	 * Create a stream-scoped helper bound to `this` basin.
	 * @param name Stream name
	 */
	public stream(name: string, options?: StreamOptions) {
		return new S2Stream(
			name,
			this.client,
			{
				...this.transportConfig,
				forceTransport: options?.forceTransport,
			},
			this.retryConfig,
		);
	}
}

export interface StreamOptions {
	forceTransport?: SessionTransports;
}
