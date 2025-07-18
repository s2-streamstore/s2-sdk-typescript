/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import * as z from "zod";
import { remap as remap$ } from "../../lib/primitives.js";
import { safeParse } from "../../lib/schemas.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import * as components from "../components/index.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";

export type CreateOrReconfigureBasinRequest = {
  /**
   * Client-specified request token for idempotent retries.
   */
  s2RequestToken?: string | undefined;
  /**
   * Basin name.
   */
  basin: string;
  createOrReconfigureBasinRequest?:
    | components.CreateOrReconfigureBasinRequest
    | null
    | undefined;
};

/** @internal */
export const CreateOrReconfigureBasinRequest$inboundSchema: z.ZodType<
  CreateOrReconfigureBasinRequest,
  z.ZodTypeDef,
  unknown
> = z.object({
  "s2-request-token": z.string().optional(),
  basin: z.string(),
  CreateOrReconfigureBasinRequest: z.nullable(
    components.CreateOrReconfigureBasinRequest$inboundSchema,
  ).optional(),
}).transform((v) => {
  return remap$(v, {
    "s2-request-token": "s2RequestToken",
    "CreateOrReconfigureBasinRequest": "createOrReconfigureBasinRequest",
  });
});

/** @internal */
export type CreateOrReconfigureBasinRequest$Outbound = {
  "s2-request-token"?: string | undefined;
  basin: string;
  CreateOrReconfigureBasinRequest?:
    | components.CreateOrReconfigureBasinRequest$Outbound
    | null
    | undefined;
};

/** @internal */
export const CreateOrReconfigureBasinRequest$outboundSchema: z.ZodType<
  CreateOrReconfigureBasinRequest$Outbound,
  z.ZodTypeDef,
  CreateOrReconfigureBasinRequest
> = z.object({
  s2RequestToken: z.string().optional(),
  basin: z.string(),
  createOrReconfigureBasinRequest: z.nullable(
    components.CreateOrReconfigureBasinRequest$outboundSchema,
  ).optional(),
}).transform((v) => {
  return remap$(v, {
    s2RequestToken: "s2-request-token",
    createOrReconfigureBasinRequest: "CreateOrReconfigureBasinRequest",
  });
});

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace CreateOrReconfigureBasinRequest$ {
  /** @deprecated use `CreateOrReconfigureBasinRequest$inboundSchema` instead. */
  export const inboundSchema = CreateOrReconfigureBasinRequest$inboundSchema;
  /** @deprecated use `CreateOrReconfigureBasinRequest$outboundSchema` instead. */
  export const outboundSchema = CreateOrReconfigureBasinRequest$outboundSchema;
  /** @deprecated use `CreateOrReconfigureBasinRequest$Outbound` instead. */
  export type Outbound = CreateOrReconfigureBasinRequest$Outbound;
}

export function createOrReconfigureBasinRequestToJSON(
  createOrReconfigureBasinRequest: CreateOrReconfigureBasinRequest,
): string {
  return JSON.stringify(
    CreateOrReconfigureBasinRequest$outboundSchema.parse(
      createOrReconfigureBasinRequest,
    ),
  );
}

export function createOrReconfigureBasinRequestFromJSON(
  jsonString: string,
): SafeParseResult<CreateOrReconfigureBasinRequest, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => CreateOrReconfigureBasinRequest$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'CreateOrReconfigureBasinRequest' from JSON`,
  );
}
