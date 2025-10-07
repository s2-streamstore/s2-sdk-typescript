import { Redacted } from "effect";
import { S2AccessTokens } from "./accessTokens";
import { S2Basin } from "./basin";
import { S2Basins } from "./basins";
import type { S2ClientOptions } from "./common";
import { createClient, createConfig } from "./generated/client";
import type { Client } from "./generated/client/types.gen";
import { S2Metrics } from "./metrics";

export class S2 {
  private readonly accessToken: Redacted.Redacted;
  private readonly client: Client;

  public readonly basins: S2Basins;
  public readonly accessTokens: S2AccessTokens;
  public readonly metrics: S2Metrics;

  constructor(options: S2ClientOptions) {
    this.accessToken = Redacted.make(options.accessToken);
    this.client = createClient(
      createConfig({
        baseUrl: "https://aws.s2.dev/v1",
        auth: () => Redacted.value(this.accessToken),
      })
    );
    this.basins = new S2Basins(this.client);
    this.accessTokens = new S2AccessTokens(this.client);
    this.metrics = new S2Metrics(this.client);
  }

  public basin(name: string) {
    return new S2Basin(name, this.accessToken);
  }
}
