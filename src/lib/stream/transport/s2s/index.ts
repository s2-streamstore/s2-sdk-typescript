/**
 * S2S HTTP/2 transport for Node.js
 * Uses the s2s binary protocol over HTTP/2 for efficient streaming
 *
 * This file should only be imported in Node.js environments
 */

import type { S2RequestOptions } from "../../../../common.js";
import {
	type Client,
	createClient,
	createConfig,
} from "../../../../generated/client/index.js";
import * as Redacted from "../../../redacted.js";
import type {
	AppendSession,
	AppendSessionOptions,
	ReadArgs,
	ReadSession,
	SessionTransport,
	TransportConfig,
} from "../../types.js";
import { FetchAppendSession, FetchReadSession } from "../fetch/index.js";

export class S2STransport implements SessionTransport {
	private readonly client: Client;
	private readonly transportConfig: TransportConfig;
	constructor(config: TransportConfig) {
		this.client = createClient(
			createConfig({
				baseUrl: config.baseUrl,
				auth: () => Redacted.value(config.accessToken),
			}),
		);
		this.transportConfig = config;
	}

	async makeAppendSession(
		stream: string,
		sessionOptions?: AppendSessionOptions,
		requestOptions?: S2RequestOptions,
	): Promise<AppendSession> {
		return FetchAppendSession.create(
			stream,
			this.transportConfig,
			sessionOptions,
			requestOptions,
		);
	}

	async makeReadSession<Format extends "string" | "bytes" = "string">(
		stream: string,
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	): Promise<ReadSession<Format>> {
		return FetchReadSession.create(this.client, stream, args, options);
	}
}
