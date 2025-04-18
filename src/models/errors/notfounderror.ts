/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import * as z from "zod";

export type NotFoundErrorData = {
  error: string;
};

export class NotFoundError extends Error {
  error: string;

  /** The original data that was passed to this error instance. */
  data$: NotFoundErrorData;

  constructor(err: NotFoundErrorData) {
    const message = err.error || "API error occurred";
    super(message);
    this.data$ = err;

    this.error = err.error;

    this.name = "NotFoundError";
  }
}

/** @internal */
export const NotFoundError$inboundSchema: z.ZodType<
  NotFoundError,
  z.ZodTypeDef,
  unknown
> = z.object({
  error: z.string(),
})
  .transform((v) => {
    return new NotFoundError(v);
  });

/** @internal */
export type NotFoundError$Outbound = {
  error: string;
};

/** @internal */
export const NotFoundError$outboundSchema: z.ZodType<
  NotFoundError$Outbound,
  z.ZodTypeDef,
  NotFoundError
> = z.instanceof(NotFoundError)
  .transform(v => v.data$)
  .pipe(z.object({
    error: z.string(),
  }));

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace NotFoundError$ {
  /** @deprecated use `NotFoundError$inboundSchema` instead. */
  export const inboundSchema = NotFoundError$inboundSchema;
  /** @deprecated use `NotFoundError$outboundSchema` instead. */
  export const outboundSchema = NotFoundError$outboundSchema;
  /** @deprecated use `NotFoundError$Outbound` instead. */
  export type Outbound = NotFoundError$Outbound;
}
