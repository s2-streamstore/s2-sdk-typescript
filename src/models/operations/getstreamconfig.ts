/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import * as z from "zod";
import { safeParse } from "../../lib/schemas.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";

export const GetStreamConfigServerList = [
  /**
   * Endpoint for the basin
   */
  "https://{basin}.b.aws.s2.dev/v1",
] as const;

export type GetStreamConfigRequest = {
  /**
   * Stream name, which must be unique within the basin.
   *
   * @remarks
   * It can be an arbitrary string upto 512 characters.
   * Backslash (`/`) is recommended as a delimiter for hierarchical naming.
   */
  stream: string;
};

/** @internal */
export const GetStreamConfigRequest$inboundSchema: z.ZodType<
  GetStreamConfigRequest,
  z.ZodTypeDef,
  unknown
> = z.object({
  stream: z.string(),
});

/** @internal */
export type GetStreamConfigRequest$Outbound = {
  stream: string;
};

/** @internal */
export const GetStreamConfigRequest$outboundSchema: z.ZodType<
  GetStreamConfigRequest$Outbound,
  z.ZodTypeDef,
  GetStreamConfigRequest
> = z.object({
  stream: z.string(),
});

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace GetStreamConfigRequest$ {
  /** @deprecated use `GetStreamConfigRequest$inboundSchema` instead. */
  export const inboundSchema = GetStreamConfigRequest$inboundSchema;
  /** @deprecated use `GetStreamConfigRequest$outboundSchema` instead. */
  export const outboundSchema = GetStreamConfigRequest$outboundSchema;
  /** @deprecated use `GetStreamConfigRequest$Outbound` instead. */
  export type Outbound = GetStreamConfigRequest$Outbound;
}

export function getStreamConfigRequestToJSON(
  getStreamConfigRequest: GetStreamConfigRequest,
): string {
  return JSON.stringify(
    GetStreamConfigRequest$outboundSchema.parse(getStreamConfigRequest),
  );
}

export function getStreamConfigRequestFromJSON(
  jsonString: string,
): SafeParseResult<GetStreamConfigRequest, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => GetStreamConfigRequest$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'GetStreamConfigRequest' from JSON`,
  );
}
