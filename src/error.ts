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
