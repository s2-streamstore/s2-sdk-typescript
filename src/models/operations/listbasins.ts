/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import * as z from "zod";
import { remap as remap$ } from "../../lib/primitives.js";
import { safeParse } from "../../lib/schemas.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import * as components from "../components/index.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";

export type ListBasinsRequest = {
  /**
   * List basin names that begin with this prefix.
   */
  prefix?: string | undefined;
  /**
   * Only return basins names that lexicographically start after this name.
   *
   * @remarks
   * This can be the last basin name seen in a previous listing, to continue from there.
   * It must be greater than or equal to the prefix if specified.
   */
  startAfter?: string | undefined;
  /**
   * Number of results, up to a maximum of 1000.
   */
  limit?: number | undefined;
};

export type ListBasinsResponse = {
  httpMeta: components.HTTPMetadata;
  listBasinsResponse?: components.ListBasinsResponse | undefined;
};

/** @internal */
export const ListBasinsRequest$inboundSchema: z.ZodType<
  ListBasinsRequest,
  z.ZodTypeDef,
  unknown
> = z.object({
  prefix: z.string().optional(),
  start_after: z.string().optional(),
  limit: z.number().int().optional(),
}).transform((v) => {
  return remap$(v, {
    "start_after": "startAfter",
  });
});

/** @internal */
export type ListBasinsRequest$Outbound = {
  prefix?: string | undefined;
  start_after?: string | undefined;
  limit?: number | undefined;
};

/** @internal */
export const ListBasinsRequest$outboundSchema: z.ZodType<
  ListBasinsRequest$Outbound,
  z.ZodTypeDef,
  ListBasinsRequest
> = z.object({
  prefix: z.string().optional(),
  startAfter: z.string().optional(),
  limit: z.number().int().optional(),
}).transform((v) => {
  return remap$(v, {
    startAfter: "start_after",
  });
});

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace ListBasinsRequest$ {
  /** @deprecated use `ListBasinsRequest$inboundSchema` instead. */
  export const inboundSchema = ListBasinsRequest$inboundSchema;
  /** @deprecated use `ListBasinsRequest$outboundSchema` instead. */
  export const outboundSchema = ListBasinsRequest$outboundSchema;
  /** @deprecated use `ListBasinsRequest$Outbound` instead. */
  export type Outbound = ListBasinsRequest$Outbound;
}

export function listBasinsRequestToJSON(
  listBasinsRequest: ListBasinsRequest,
): string {
  return JSON.stringify(
    ListBasinsRequest$outboundSchema.parse(listBasinsRequest),
  );
}

export function listBasinsRequestFromJSON(
  jsonString: string,
): SafeParseResult<ListBasinsRequest, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => ListBasinsRequest$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'ListBasinsRequest' from JSON`,
  );
}

/** @internal */
export const ListBasinsResponse$inboundSchema: z.ZodType<
  ListBasinsResponse,
  z.ZodTypeDef,
  unknown
> = z.object({
  HttpMeta: components.HTTPMetadata$inboundSchema,
  ListBasinsResponse: components.ListBasinsResponse$inboundSchema.optional(),
}).transform((v) => {
  return remap$(v, {
    "HttpMeta": "httpMeta",
    "ListBasinsResponse": "listBasinsResponse",
  });
});

/** @internal */
export type ListBasinsResponse$Outbound = {
  HttpMeta: components.HTTPMetadata$Outbound;
  ListBasinsResponse?: components.ListBasinsResponse$Outbound | undefined;
};

/** @internal */
export const ListBasinsResponse$outboundSchema: z.ZodType<
  ListBasinsResponse$Outbound,
  z.ZodTypeDef,
  ListBasinsResponse
> = z.object({
  httpMeta: components.HTTPMetadata$outboundSchema,
  listBasinsResponse: components.ListBasinsResponse$outboundSchema.optional(),
}).transform((v) => {
  return remap$(v, {
    httpMeta: "HttpMeta",
    listBasinsResponse: "ListBasinsResponse",
  });
});

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace ListBasinsResponse$ {
  /** @deprecated use `ListBasinsResponse$inboundSchema` instead. */
  export const inboundSchema = ListBasinsResponse$inboundSchema;
  /** @deprecated use `ListBasinsResponse$outboundSchema` instead. */
  export const outboundSchema = ListBasinsResponse$outboundSchema;
  /** @deprecated use `ListBasinsResponse$Outbound` instead. */
  export type Outbound = ListBasinsResponse$Outbound;
}

export function listBasinsResponseToJSON(
  listBasinsResponse: ListBasinsResponse,
): string {
  return JSON.stringify(
    ListBasinsResponse$outboundSchema.parse(listBasinsResponse),
  );
}

export function listBasinsResponseFromJSON(
  jsonString: string,
): SafeParseResult<ListBasinsResponse, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => ListBasinsResponse$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'ListBasinsResponse' from JSON`,
  );
}
