/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import * as z from "zod";

export type RetryableErrorData = {
  error: string;
};

export class RetryableError extends Error {
  error: string;

  /** The original data that was passed to this error instance. */
  data$: RetryableErrorData;

  constructor(err: RetryableErrorData) {
    const message = err.error || "API error occurred";
    super(message);
    this.data$ = err;

    this.error = err.error;

    this.name = "RetryableError";
  }
}

/** @internal */
export const RetryableError$inboundSchema: z.ZodType<
  RetryableError,
  z.ZodTypeDef,
  unknown
> = z.object({
  error: z.string(),
})
  .transform((v) => {
    return new RetryableError(v);
  });

/** @internal */
export type RetryableError$Outbound = {
  error: string;
};

/** @internal */
export const RetryableError$outboundSchema: z.ZodType<
  RetryableError$Outbound,
  z.ZodTypeDef,
  RetryableError
> = z.instanceof(RetryableError)
  .transform(v => v.data$)
  .pipe(z.object({
    error: z.string(),
  }));

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace RetryableError$ {
  /** @deprecated use `RetryableError$inboundSchema` instead. */
  export const inboundSchema = RetryableError$inboundSchema;
  /** @deprecated use `RetryableError$outboundSchema` instead. */
  export const outboundSchema = RetryableError$outboundSchema;
  /** @deprecated use `RetryableError$Outbound` instead. */
  export type Outbound = RetryableError$Outbound;
}
