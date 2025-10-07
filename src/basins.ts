import type { DataToObject, S2RequestOptions } from "./common";
import { S2Error } from "./error";
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
import type { Client } from "./generated/client/types.gen";

export class S2Basins {
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
