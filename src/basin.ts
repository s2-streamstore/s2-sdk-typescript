import { Redacted } from "effect";
import { createClient, createConfig } from "./generated/client";
import type { Client } from "./generated/client/types.gen";
import { S2Stream } from "./stream";
import { S2Streams } from "./streams";

export class S2Basin {
	private readonly client: Client;
	private readonly accessToken: Redacted.Redacted;

	public readonly name: string;
	public readonly streams: S2Streams;

	/**
	 * Create a basin-scoped client that talks to `https://{basin}.b.aws.s2.dev/v1`.
	 *
	 * Use this to work with streams inside a single basin.
	 * @param name Basin name
	 * @param accessToken Redacted access token from the parent `S2` client
	 */
	constructor(
		name: string,
		options: { accessToken: Redacted.Redacted; baseUrl: string },
	) {
		this.name = name;
		this.accessToken = options.accessToken;
		this.client = createClient(
			createConfig({
				baseUrl: options.baseUrl,
				auth: () => Redacted.value(this.accessToken),
			}),
		);
		this.streams = new S2Streams(this.client);
	}

	/**
	 * Create a stream-scoped helper bound to `this` basin.
	 * @param name Stream name
	 */
	public stream(name: string) {
		return new S2Stream(name, this.client);
	}
}
