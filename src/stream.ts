import type { S2RequestOptions } from "./common";
import { S2Error } from "./error";
import { type AppendAck, checkTail, type ReadEvent } from "./generated";
import type { Client } from "./generated/client/types.gen";

export class S2Stream {
  private readonly client: Client;

  public readonly name: string;

  constructor(name: string, client: Client) {
    this.name = name;
    this.client = client;
  }

  public async checkTail(options?: S2RequestOptions) {
    const response = await checkTail({
      client: this.client,
      path: {
        stream: this.name,
      },
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

  public async read(): Promise<void> {
    return void 0;
  }
  public async append(): Promise<void> {
    return void 0;
  }
  public async readSession(): Promise<ReadSession> {
    return new ReadSession();
  }
  public async appendSession(): Promise<AppendSession> {
    return new AppendSession();
  }
}

declare class ReadSession implements AsyncDisposable, AsyncIterable<ReadEvent> {
  [Symbol.asyncDispose](): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<ReadEvent>;
}
declare class AppendSession implements AsyncDisposable {
  [Symbol.asyncDispose](): Promise<void>;
  acks(): AsyncIterableIterator<AppendAck>;
  send(): Promise<void>;
}
