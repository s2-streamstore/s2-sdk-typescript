/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import * as z from "zod";
import { remap as remap$ } from "../../lib/primitives.js";
import { safeParse } from "../../lib/schemas.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";

export type CheckTailRequest = {
  /**
   * Name of the stream.
   */
  stream: string;
  /**
   * Name of the basin.
   */
  s2Basin?: string | undefined;
};

export type CheckTailResponse = {
  headers: { [k: string]: Array<string> };
};

/** @internal */
export const CheckTailRequest$inboundSchema: z.ZodType<
  CheckTailRequest,
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
export type CheckTailRequest$Outbound = {
  stream: string;
  "s2-basin"?: string | undefined;
};

/** @internal */
export const CheckTailRequest$outboundSchema: z.ZodType<
  CheckTailRequest$Outbound,
  z.ZodTypeDef,
  CheckTailRequest
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

/** @internal */
export const CheckTailResponse$inboundSchema: z.ZodType<
  CheckTailResponse,
  z.ZodTypeDef,
  unknown
> = z.object({
  Headers: z.record(z.array(z.string())),
}).transform((v) => {
  return remap$(v, {
    "Headers": "headers",
  });
});

/** @internal */
export type CheckTailResponse$Outbound = {
  Headers: { [k: string]: Array<string> };
};

/** @internal */
export const CheckTailResponse$outboundSchema: z.ZodType<
  CheckTailResponse$Outbound,
  z.ZodTypeDef,
  CheckTailResponse
> = z.object({
  headers: z.record(z.array(z.string())),
}).transform((v) => {
  return remap$(v, {
    headers: "Headers",
  });
});

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace CheckTailResponse$ {
  /** @deprecated use `CheckTailResponse$inboundSchema` instead. */
  export const inboundSchema = CheckTailResponse$inboundSchema;
  /** @deprecated use `CheckTailResponse$outboundSchema` instead. */
  export const outboundSchema = CheckTailResponse$outboundSchema;
  /** @deprecated use `CheckTailResponse$Outbound` instead. */
  export type Outbound = CheckTailResponse$Outbound;
}

export function checkTailResponseToJSON(
  checkTailResponse: CheckTailResponse,
): string {
  return JSON.stringify(
    CheckTailResponse$outboundSchema.parse(checkTailResponse),
  );
}

export function checkTailResponseFromJSON(
  jsonString: string,
): SafeParseResult<CheckTailResponse, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => CheckTailResponse$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'CheckTailResponse' from JSON`,
  );
}
