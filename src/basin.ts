import { createClient, createConfig } from "./generated/client/index.js";
import type { Client } from "./generated/client/types.gen.js";
import * as Redacted from "./lib/redacted.js";
import type { TransportConfig } from "./lib/stream/types.js";
import { S2Stream } from "./stream.js";
import { S2Streams } from "./streams.js";

export class S2Basin {
	private readonly client: Client;
	private readonly transportConfig: TransportConfig;
	public readonly name: string;
	public readonly streams: S2Streams;

	/**
	 * Create a basin-scoped client that talks to `https://{basin}.b.aws.s2.dev/v1`.
	 *
	 * Use this to work with streams inside a single basin.
	 * @param name Basin name
	 * @param accessToken Redacted access token from the parent `S2` client
	 */
	constructor(name: string, options: TransportConfig) {
		this.name = name;
		this.transportConfig = {
			baseUrl: options.baseUrl,
			accessToken: options.accessToken,
		};
		this.client = createClient(
			createConfig({
				baseUrl: this.transportConfig.baseUrl,
				auth: () => Redacted.value(this.transportConfig.accessToken),
			}),
		);
		this.streams = new S2Streams(this.client);
	}

	/**
	 * Create a stream-scoped helper bound to `this` basin.
	 * @param name Stream name
	 */
	public stream(name: string) {
		return new S2Stream(name, this.client, {
			baseUrl: this.transportConfig.baseUrl,
			accessToken: this.transportConfig.accessToken,
		});
	}
}
