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

  constructor(name: string, accessToken: Redacted.Redacted) {
    this.name = name;
    this.accessToken = accessToken;
    this.client = createClient(
      createConfig({
        baseUrl: `https://${name}.b.aws.s2.dev/v1`,
        auth: () => Redacted.value(this.accessToken),
      })
    );
    this.streams = new S2Streams(this.client);
  }

  public stream(name: string) {
    return new S2Stream(name, this.client);
  }
}
