/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import * as z from "zod";
import { safeParse } from "../../lib/schemas.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";

export const CheckTailServerList = [
  /**
   * Endpoint for the basin
   */
  "https://{basin}.b.aws.s2.dev/v1",
] as const;

export type CheckTailRequest = {
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
export const CheckTailRequest$inboundSchema: z.ZodType<
  CheckTailRequest,
  z.ZodTypeDef,
  unknown
> = z.object({
  stream: z.string(),
});

/** @internal */
export type CheckTailRequest$Outbound = {
  stream: string;
};

/** @internal */
export const CheckTailRequest$outboundSchema: z.ZodType<
  CheckTailRequest$Outbound,
  z.ZodTypeDef,
  CheckTailRequest
> = z.object({
  stream: z.string(),
});

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace CheckTailRequest$ {
  /** @deprecated use `CheckTailRequest$inboundSchema` instead. */
  export const inboundSchema = CheckTailRequest$inboundSchema;
  /** @deprecated use `CheckTailRequest$outboundSchema` instead. */
  export const outboundSchema = CheckTailRequest$outboundSchema;
  /** @deprecated use `CheckTailRequest$Outbound` instead. */
  export type Outbound = CheckTailRequest$Outbound;
}

export function checkTailRequestToJSON(
  checkTailRequest: CheckTailRequest,
): string {
  return JSON.stringify(
    CheckTailRequest$outboundSchema.parse(checkTailRequest),
  );
}

export function checkTailRequestFromJSON(
  jsonString: string,
): SafeParseResult<CheckTailRequest, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => CheckTailRequest$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'CheckTailRequest' from JSON`,
  );
}
