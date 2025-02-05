/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import * as z from "zod";
import { remap as remap$ } from "../../lib/primitives.js";
import { safeParse } from "../../lib/schemas.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import * as components from "../components/index.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";

export const AppendServerList = [
  /**
   * Endpoint for the basin
   */
  "https://{basin}.b.aws.s2.dev/v1alpha",
] as const;

/**
 * json: utf-8 plaintext data.
 *
 * @remarks
 * json-binsafe: base64 encoded binary data.
 */
export type HeaderS2Format = components.FormatOption;

export type AppendRequest = {
  /**
   * json: utf-8 plaintext data.
   *
   * @remarks
   * json-binsafe: base64 encoded binary data.
   */
  s2Format?: components.FormatOption | undefined;
  /**
   * Name of the stream.
   */
  stream: string;
  appendInput: components.AppendInput;
};

/** @internal */
export const HeaderS2Format$inboundSchema: z.ZodType<
  HeaderS2Format,
  z.ZodTypeDef,
  unknown
> = components.FormatOption$inboundSchema;

/** @internal */
export type HeaderS2Format$Outbound = string;

/** @internal */
export const HeaderS2Format$outboundSchema: z.ZodType<
  HeaderS2Format$Outbound,
  z.ZodTypeDef,
  HeaderS2Format
> = components.FormatOption$outboundSchema;

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace HeaderS2Format$ {
  /** @deprecated use `HeaderS2Format$inboundSchema` instead. */
  export const inboundSchema = HeaderS2Format$inboundSchema;
  /** @deprecated use `HeaderS2Format$outboundSchema` instead. */
  export const outboundSchema = HeaderS2Format$outboundSchema;
  /** @deprecated use `HeaderS2Format$Outbound` instead. */
  export type Outbound = HeaderS2Format$Outbound;
}

export function headerS2FormatToJSON(headerS2Format: HeaderS2Format): string {
  return JSON.stringify(HeaderS2Format$outboundSchema.parse(headerS2Format));
}

export function headerS2FormatFromJSON(
  jsonString: string,
): SafeParseResult<HeaderS2Format, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => HeaderS2Format$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'HeaderS2Format' from JSON`,
  );
}

/** @internal */
export const AppendRequest$inboundSchema: z.ZodType<
  AppendRequest,
  z.ZodTypeDef,
  unknown
> = z.object({
  "s2-format": components.FormatOption$inboundSchema.optional(),
  stream: z.string(),
  AppendInput: components.AppendInput$inboundSchema,
}).transform((v) => {
  return remap$(v, {
    "s2-format": "s2Format",
    "AppendInput": "appendInput",
  });
});

/** @internal */
export type AppendRequest$Outbound = {
  "s2-format"?: string | undefined;
  stream: string;
  AppendInput: components.AppendInput$Outbound;
};

/** @internal */
export const AppendRequest$outboundSchema: z.ZodType<
  AppendRequest$Outbound,
  z.ZodTypeDef,
  AppendRequest
> = z.object({
  s2Format: components.FormatOption$outboundSchema.optional(),
  stream: z.string(),
  appendInput: components.AppendInput$outboundSchema,
}).transform((v) => {
  return remap$(v, {
    s2Format: "s2-format",
    appendInput: "AppendInput",
  });
});

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace AppendRequest$ {
  /** @deprecated use `AppendRequest$inboundSchema` instead. */
  export const inboundSchema = AppendRequest$inboundSchema;
  /** @deprecated use `AppendRequest$outboundSchema` instead. */
  export const outboundSchema = AppendRequest$outboundSchema;
  /** @deprecated use `AppendRequest$Outbound` instead. */
  export type Outbound = AppendRequest$Outbound;
}

export function appendRequestToJSON(appendRequest: AppendRequest): string {
  return JSON.stringify(AppendRequest$outboundSchema.parse(appendRequest));
}

export function appendRequestFromJSON(
  jsonString: string,
): SafeParseResult<AppendRequest, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => AppendRequest$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'AppendRequest' from JSON`,
  );
}
