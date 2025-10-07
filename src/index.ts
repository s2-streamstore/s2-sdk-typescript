import { Redacted } from "effect";
import {
  type AccountMetricsData,
  accountMetrics,
  type BasinMetricsData,
  basinMetrics,
  type CreateBasinData,
  createBasin,
  type DeleteBasinData,
  deleteBasin,
  type GetBasinConfigData,
  getBasinConfig,
  type IssueAccessTokenData,
  issueAccessToken,
  type ListAccessTokensData,
  listAccessTokens,
  listBasins,
  type ReconfigureBasinData,
  type RevokeAccessTokenData,
  reconfigureBasin,
  revokeAccessToken,
  type StreamMetricsData,
  streamMetrics,
} from "./generated";
import { createClient, createConfig } from "./generated/client";
import type { Client } from "./generated/client/types.gen";

type S2ClientOptions = {
  accessToken: string;
};

type S2RequestOptions = {
  signal?: AbortSignal;
};

type DataToObject<T> = (T extends { body: infer B } ? B : {}) &
  (T extends { path: infer P } ? P : {}) &
  (T extends { query: infer Q } ? Q : {});

export class S2Error extends Error {
  public readonly code?: string;
  public readonly status?: number;
  public readonly data?: Record<string, unknown>;

  constructor({
    message,
    code,
    status,
    data,
  }: {
    message: string;
    code?: string;
    status?: number;
    data?: Record<string, unknown>;
  }) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

class S2Basins {
  private readonly client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  public async list(options?: S2RequestOptions) {
    const response = await listBasins({
      client: this.client,
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

  public async create(
    args: DataToObject<CreateBasinData>,
    options?: S2RequestOptions
  ) {
    const response = await createBasin({
      client: this.client,
      body: args,
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

  public async getConfig(
    args: DataToObject<GetBasinConfigData>,
    options?: S2RequestOptions
  ) {
    const response = await getBasinConfig({
      client: this.client,
      path: args,
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

  public async delete(
    args: DataToObject<DeleteBasinData>,
    options?: S2RequestOptions
  ) {
    const response = await deleteBasin({
      client: this.client,
      path: args,
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

  public async reconfigure(
    args: DataToObject<ReconfigureBasinData>,
    options?: S2RequestOptions
  ) {
    const response = await reconfigureBasin({
      client: this.client,
      path: args,
      body: args,
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

class S2AccessTokens {
  readonly client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  public async list(
    args?: DataToObject<ListAccessTokensData>,
    options?: S2RequestOptions
  ) {
    const response = await listAccessTokens({
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

  public async issue(
    args: DataToObject<IssueAccessTokenData>,
    options?: S2RequestOptions
  ) {
    const response = await issueAccessToken({
      client: this.client,
      body: args,
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

  public async revoke(
    args: DataToObject<RevokeAccessTokenData>,
    options?: S2RequestOptions
  ) {
    const response = await revokeAccessToken({
      client: this.client,
      path: args,
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

class S2Metrics {
  readonly client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  public async account(
    args: DataToObject<AccountMetricsData>,
    options?: S2RequestOptions
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

  public async basin(
    args: DataToObject<BasinMetricsData>,
    options?: S2RequestOptions
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

  public async stream(
    args: DataToObject<StreamMetricsData>,
    options?: S2RequestOptions
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

class S2Streams {
  private readonly client: Client;
  constructor(client: Client) {
    this.client = client;
  }
}

class S2Stream {
  private readonly client: Client;

  public readonly name: string;

  constructor(name: string, client: Client) {
    this.name = name;
    this.client = client;
  }
}

class S2Basin {
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

const s2 = new S2({
  accessToken: "123",
});

const basins = await s2.basins.list();
console.log(basins.basins);
