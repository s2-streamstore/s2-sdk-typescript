/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import * as z from "zod";
import { remap as remap$ } from "../../lib/primitives.js";
import { safeParse } from "../../lib/schemas.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";

export const DeleteStreamServerList = [
  "https://aws.s2.dev/v1alpha",
  /**
   * Directly access the basin
   */
  "https://{basin}.b.aws.s2.dev/v1alpha",
] as const;

export type DeleteStreamRequest = {
  /**
   * Name of the stream.
   */
  stream: string;
  /**
   * Name of the basin. Use when accessing the basin through the Account Endpoint.
   */
  s2Basin?: string | undefined;
};

/** @internal */
export const DeleteStreamRequest$inboundSchema: z.ZodType<
  DeleteStreamRequest,
  z.ZodTypeDef,
  unknown
> = z.object({
  stream: z.string(),
  "s2-basin": z.string().optional(),
}).transform((v) => {
  return remap$(v, {
    "s2-basin": "s2Basin",
  });
});

/** @internal */
export type DeleteStreamRequest$Outbound = {
  stream: string;
  "s2-basin"?: string | undefined;
};

/** @internal */
export const DeleteStreamRequest$outboundSchema: z.ZodType<
  DeleteStreamRequest$Outbound,
  z.ZodTypeDef,
  DeleteStreamRequest
> = z.object({
  stream: z.string(),
  s2Basin: z.string().optional(),
}).transform((v) => {
  return remap$(v, {
    s2Basin: "s2-basin",
  });
});

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace DeleteStreamRequest$ {
  /** @deprecated use `DeleteStreamRequest$inboundSchema` instead. */
  export const inboundSchema = DeleteStreamRequest$inboundSchema;
  /** @deprecated use `DeleteStreamRequest$outboundSchema` instead. */
  export const outboundSchema = DeleteStreamRequest$outboundSchema;
  /** @deprecated use `DeleteStreamRequest$Outbound` instead. */
  export type Outbound = DeleteStreamRequest$Outbound;
}

export function deleteStreamRequestToJSON(
  deleteStreamRequest: DeleteStreamRequest,
): string {
  return JSON.stringify(
    DeleteStreamRequest$outboundSchema.parse(deleteStreamRequest),
  );
}

export function deleteStreamRequestFromJSON(
  jsonString: string,
): SafeParseResult<DeleteStreamRequest, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => DeleteStreamRequest$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'DeleteStreamRequest' from JSON`,
  );
}
