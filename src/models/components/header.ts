/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import * as z from "zod";
import { safeParse } from "../../lib/schemas.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";

/**
 * Headers add structured information to a record as name-value pairs.
 */
export type Header = {
  /**
   * Header name blob.
   *
   * @remarks
   * The name cannot be empty, with the exception of an S2 command record.
   */
  name: string;
  /**
   * Header value blob.
   */
  value: string;
};

/** @internal */
export const Header$inboundSchema: z.ZodType<Header, z.ZodTypeDef, unknown> = z
  .object({
    name: z.string(),
    value: z.string(),
  });

/** @internal */
export type Header$Outbound = {
  name: string;
  value: string;
};

/** @internal */
export const Header$outboundSchema: z.ZodType<
  Header$Outbound,
  z.ZodTypeDef,
  Header
> = z.object({
  name: z.string(),
  value: z.string(),
});

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace Header$ {
  /** @deprecated use `Header$inboundSchema` instead. */
  export const inboundSchema = Header$inboundSchema;
  /** @deprecated use `Header$outboundSchema` instead. */
  export const outboundSchema = Header$outboundSchema;
  /** @deprecated use `Header$Outbound` instead. */
  export type Outbound = Header$Outbound;
}

export function headerToJSON(header: Header): string {
  return JSON.stringify(Header$outboundSchema.parse(header));
}

export function headerFromJSON(
  jsonString: string,
): SafeParseResult<Header, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => Header$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'Header' from JSON`,
  );
}
