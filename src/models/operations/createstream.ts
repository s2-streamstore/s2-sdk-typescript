/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import * as z from "zod";
import { remap as remap$ } from "../../lib/primitives.js";
import { safeParse } from "../../lib/schemas.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import * as components from "../components/index.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";

export type CreateStreamRequest = {
  /**
   * Name of the stream.
   */
  stream: string;
  /**
   * Name of the basin.
   */
  s2Basin?: string | undefined;
  s2RequestToken?: string | undefined;
  createStreamRequest: components.CreateStreamRequest;
};

/** @internal */
export const CreateStreamRequest$inboundSchema: z.ZodType<
  CreateStreamRequest,
  z.ZodTypeDef,
  unknown
> = z.object({
  stream: z.string(),
  "s2-basin": z.string().optional(),
  "s2-request-token": z.string().optional(),
  CreateStreamRequest: components.CreateStreamRequest$inboundSchema,
}).transform((v) => {
  return remap$(v, {
    "s2-basin": "s2Basin",
    "s2-request-token": "s2RequestToken",
    "CreateStreamRequest": "createStreamRequest",
  });
});

/** @internal */
export type CreateStreamRequest$Outbound = {
  stream: string;
  "s2-basin"?: string | undefined;
  "s2-request-token"?: string | undefined;
  CreateStreamRequest: components.CreateStreamRequest$Outbound;
};

/** @internal */
export const CreateStreamRequest$outboundSchema: z.ZodType<
  CreateStreamRequest$Outbound,
  z.ZodTypeDef,
  CreateStreamRequest
> = z.object({
  stream: z.string(),
  s2Basin: z.string().optional(),
  s2RequestToken: z.string().optional(),
  createStreamRequest: components.CreateStreamRequest$outboundSchema,
}).transform((v) => {
  return remap$(v, {
    s2Basin: "s2-basin",
    s2RequestToken: "s2-request-token",
    createStreamRequest: "CreateStreamRequest",
  });
});

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace CreateStreamRequest$ {
  /** @deprecated use `CreateStreamRequest$inboundSchema` instead. */
  export const inboundSchema = CreateStreamRequest$inboundSchema;
  /** @deprecated use `CreateStreamRequest$outboundSchema` instead. */
  export const outboundSchema = CreateStreamRequest$outboundSchema;
  /** @deprecated use `CreateStreamRequest$Outbound` instead. */
  export type Outbound = CreateStreamRequest$Outbound;
}

export function createStreamRequestToJSON(
  createStreamRequest: CreateStreamRequest,
): string {
  return JSON.stringify(
    CreateStreamRequest$outboundSchema.parse(createStreamRequest),
  );
}

export function createStreamRequestFromJSON(
  jsonString: string,
): SafeParseResult<CreateStreamRequest, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => CreateStreamRequest$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'CreateStreamRequest' from JSON`,
  );
}
