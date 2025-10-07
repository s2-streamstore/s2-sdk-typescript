import type { Client } from "./generated/client/types.gen";

export class S2Stream {
  private readonly client: Client;

  public readonly name: string;

  constructor(name: string, client: Client) {
    this.name = name;
    this.client = client;
  }
}
