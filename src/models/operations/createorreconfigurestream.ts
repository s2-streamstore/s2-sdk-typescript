/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import * as z from "zod";
import { remap as remap$ } from "../../lib/primitives.js";
import { safeParse } from "../../lib/schemas.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import * as components from "../components/index.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";

export const CreateOrReconfigureStreamServerList = [
  /**
   * Endpoint for the basin
   */
  "https://{basin}.b.aws.s2.dev/v1",
] as const;

export type CreateOrReconfigureStreamRequest = {
  /**
   * Stream name.
   */
  stream: string;
  /**
   * Client-specified request token for idempotent retries.
   */
  s2RequestToken?: string | undefined;
  /**
   * Basin name for basin-specific endpoints
   */
  s2Basin: string;
  streamConfig?: components.StreamConfig | null | undefined;
};

/** @internal */
export const CreateOrReconfigureStreamRequest$inboundSchema: z.ZodType<
  CreateOrReconfigureStreamRequest,
  z.ZodTypeDef,
  unknown
> = z.object({
  stream: z.string(),
  "s2-request-token": z.string().optional(),
  "s2-basin": z.string(),
  StreamConfig: z.nullable(components.StreamConfig$inboundSchema).optional(),
}).transform((v) => {
  return remap$(v, {
    "s2-request-token": "s2RequestToken",
    "s2-basin": "s2Basin",
    "StreamConfig": "streamConfig",
  });
});

/** @internal */
export type CreateOrReconfigureStreamRequest$Outbound = {
  stream: string;
  "s2-request-token"?: string | undefined;
  "s2-basin": string;
  StreamConfig?: components.StreamConfig$Outbound | null | undefined;
};

/** @internal */
export const CreateOrReconfigureStreamRequest$outboundSchema: z.ZodType<
  CreateOrReconfigureStreamRequest$Outbound,
  z.ZodTypeDef,
  CreateOrReconfigureStreamRequest
> = z.object({
  stream: z.string(),
  s2RequestToken: z.string().optional(),
  s2Basin: z.string(),
  streamConfig: z.nullable(components.StreamConfig$outboundSchema).optional(),
}).transform((v) => {
  return remap$(v, {
    s2RequestToken: "s2-request-token",
    s2Basin: "s2-basin",
    streamConfig: "StreamConfig",
  });
});

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace CreateOrReconfigureStreamRequest$ {
  /** @deprecated use `CreateOrReconfigureStreamRequest$inboundSchema` instead. */
  export const inboundSchema = CreateOrReconfigureStreamRequest$inboundSchema;
  /** @deprecated use `CreateOrReconfigureStreamRequest$outboundSchema` instead. */
  export const outboundSchema = CreateOrReconfigureStreamRequest$outboundSchema;
  /** @deprecated use `CreateOrReconfigureStreamRequest$Outbound` instead. */
  export type Outbound = CreateOrReconfigureStreamRequest$Outbound;
}

export function createOrReconfigureStreamRequestToJSON(
  createOrReconfigureStreamRequest: CreateOrReconfigureStreamRequest,
): string {
  return JSON.stringify(
    CreateOrReconfigureStreamRequest$outboundSchema.parse(
      createOrReconfigureStreamRequest,
    ),
  );
}

export function createOrReconfigureStreamRequestFromJSON(
  jsonString: string,
): SafeParseResult<CreateOrReconfigureStreamRequest, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => CreateOrReconfigureStreamRequest$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'CreateOrReconfigureStreamRequest' from JSON`,
  );
}
