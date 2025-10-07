import { Redacted } from "effect";
import {
  type CreateBasinData,
  createBasin,
  type DeleteBasinData,
  deleteBasin,
  type GetBasinConfigData,
  getBasinConfig,
  listBasins,
  type ReconfigureBasinData,
  reconfigureBasin,
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
  private client: Client;
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

export class S2 {
  private accessToken: Redacted.Redacted;
  private client: Client;

  public basins: S2Basins;

  constructor(options: S2ClientOptions) {
    this.accessToken = Redacted.make(options.accessToken);
    this.client = createClient(
      createConfig({
        baseUrl: "https://aws.s2.dev/v1",
        auth: () => Redacted.value(this.accessToken),
      })
    );
    this.basins = new S2Basins(this.client);
  }
}

const s2 = new S2({
  accessToken: "123",
});

const basins = await s2.basins.list();
console.log(basins.basins);
