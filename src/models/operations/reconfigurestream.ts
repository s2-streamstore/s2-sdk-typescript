/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import * as z from "zod";
import { remap as remap$ } from "../../lib/primitives.js";
import { safeParse } from "../../lib/schemas.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import * as components from "../components/index.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";

export const ReconfigureStreamServerList = [
  "https://aws.s2.dev/v1alpha",
  /**
   * Directly access the basin
   */
  "https://{basin}.b.aws.s2.dev/v1alpha",
] as const;

export type ReconfigureStreamRequest = {
  /**
   * Name of the stream.
   */
  stream: string;
  /**
   * Name of the basin. Use when accessing the basin through the Account Endpoint.
   */
  s2Basin?: string | undefined;
  reconfigureStreamRequest: components.ReconfigureStreamRequest;
};

/** @internal */
export const ReconfigureStreamRequest$inboundSchema: z.ZodType<
  ReconfigureStreamRequest,
  z.ZodTypeDef,
  unknown
> = z.object({
  stream: z.string(),
  "s2-basin": z.string().optional(),
  ReconfigureStreamRequest: components.ReconfigureStreamRequest$inboundSchema,
}).transform((v) => {
  return remap$(v, {
    "s2-basin": "s2Basin",
    "ReconfigureStreamRequest": "reconfigureStreamRequest",
  });
});

/** @internal */
export type ReconfigureStreamRequest$Outbound = {
  stream: string;
  "s2-basin"?: string | undefined;
  ReconfigureStreamRequest: components.ReconfigureStreamRequest$Outbound;
};

/** @internal */
export const ReconfigureStreamRequest$outboundSchema: z.ZodType<
  ReconfigureStreamRequest$Outbound,
  z.ZodTypeDef,
  ReconfigureStreamRequest
> = z.object({
  stream: z.string(),
  s2Basin: z.string().optional(),
  reconfigureStreamRequest: components.ReconfigureStreamRequest$outboundSchema,
}).transform((v) => {
  return remap$(v, {
    s2Basin: "s2-basin",
    reconfigureStreamRequest: "ReconfigureStreamRequest",
  });
});

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace ReconfigureStreamRequest$ {
  /** @deprecated use `ReconfigureStreamRequest$inboundSchema` instead. */
  export const inboundSchema = ReconfigureStreamRequest$inboundSchema;
  /** @deprecated use `ReconfigureStreamRequest$outboundSchema` instead. */
  export const outboundSchema = ReconfigureStreamRequest$outboundSchema;
  /** @deprecated use `ReconfigureStreamRequest$Outbound` instead. */
  export type Outbound = ReconfigureStreamRequest$Outbound;
}

export function reconfigureStreamRequestToJSON(
  reconfigureStreamRequest: ReconfigureStreamRequest,
): string {
  return JSON.stringify(
    ReconfigureStreamRequest$outboundSchema.parse(reconfigureStreamRequest),
  );
}

export function reconfigureStreamRequestFromJSON(
  jsonString: string,
): SafeParseResult<ReconfigureStreamRequest, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => ReconfigureStreamRequest$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'ReconfigureStreamRequest' from JSON`,
  );
}
