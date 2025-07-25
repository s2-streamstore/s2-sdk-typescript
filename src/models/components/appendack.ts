/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import * as z from "zod";
import { safeParse } from "../../lib/schemas.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import {
  StreamPosition,
  StreamPosition$inboundSchema,
  StreamPosition$Outbound,
  StreamPosition$outboundSchema,
} from "./streamposition.js";

/**
 * Success response to an `append` request.
 */
export type AppendAck = {
  /**
   * Position of a record in a stream.
   */
  end: StreamPosition;
  /**
   * Position of a record in a stream.
   */
  start: StreamPosition;
  /**
   * Position of a record in a stream.
   */
  tail: StreamPosition;
};

/** @internal */
export const AppendAck$inboundSchema: z.ZodType<
  AppendAck,
  z.ZodTypeDef,
  unknown
> = z.object({
  end: StreamPosition$inboundSchema,
  start: StreamPosition$inboundSchema,
  tail: StreamPosition$inboundSchema,
});

/** @internal */
export type AppendAck$Outbound = {
  end: StreamPosition$Outbound;
  start: StreamPosition$Outbound;
  tail: StreamPosition$Outbound;
};

/** @internal */
export const AppendAck$outboundSchema: z.ZodType<
  AppendAck$Outbound,
  z.ZodTypeDef,
  AppendAck
> = z.object({
  end: StreamPosition$outboundSchema,
  start: StreamPosition$outboundSchema,
  tail: StreamPosition$outboundSchema,
});

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace AppendAck$ {
  /** @deprecated use `AppendAck$inboundSchema` instead. */
  export const inboundSchema = AppendAck$inboundSchema;
  /** @deprecated use `AppendAck$outboundSchema` instead. */
  export const outboundSchema = AppendAck$outboundSchema;
  /** @deprecated use `AppendAck$Outbound` instead. */
  export type Outbound = AppendAck$Outbound;
}

export function appendAckToJSON(appendAck: AppendAck): string {
  return JSON.stringify(AppendAck$outboundSchema.parse(appendAck));
}

export function appendAckFromJSON(
  jsonString: string,
): SafeParseResult<AppendAck, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => AppendAck$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'AppendAck' from JSON`,
  );
}
