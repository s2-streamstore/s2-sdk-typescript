/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import * as z from "zod";
import { safeParse } from "../../lib/schemas.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";

/**
 * Record to be appended to a stream.
 */
export type AppendRecord = {
  /**
   * Body of this record.
   */
  body: string;
  /**
   * Series of name-value pairs for this record.
   */
  headers?: Array<Array<string>> | undefined;
  /**
   * Timestamp for this record in milliseconds since Unix epoch.
   *
   * @remarks
   * The service ensures monotonicity by adjusting it up if necessary to the maximum observed timestamp.
   * A timestamp detected to be in the future will be adjusted down.
   * If not provided, the semantics depend on the stream's `require_client_timestamps` config.
   */
  timestamp?: number | null | undefined;
};

/** @internal */
export const AppendRecord$inboundSchema: z.ZodType<
  AppendRecord,
  z.ZodTypeDef,
  unknown
> = z.object({
  body: z.string(),
  headers: z.array(z.array(z.string())).optional(),
  timestamp: z.nullable(z.number().int()).optional(),
});

/** @internal */
export type AppendRecord$Outbound = {
  body: string;
  headers?: Array<Array<string>> | undefined;
  timestamp?: number | null | undefined;
};

/** @internal */
export const AppendRecord$outboundSchema: z.ZodType<
  AppendRecord$Outbound,
  z.ZodTypeDef,
  AppendRecord
> = z.object({
  body: z.string(),
  headers: z.array(z.array(z.string())).optional(),
  timestamp: z.nullable(z.number().int()).optional(),
});

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace AppendRecord$ {
  /** @deprecated use `AppendRecord$inboundSchema` instead. */
  export const inboundSchema = AppendRecord$inboundSchema;
  /** @deprecated use `AppendRecord$outboundSchema` instead. */
  export const outboundSchema = AppendRecord$outboundSchema;
  /** @deprecated use `AppendRecord$Outbound` instead. */
  export type Outbound = AppendRecord$Outbound;
}

export function appendRecordToJSON(appendRecord: AppendRecord): string {
  return JSON.stringify(AppendRecord$outboundSchema.parse(appendRecord));
}

export function appendRecordFromJSON(
  jsonString: string,
): SafeParseResult<AppendRecord, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => AppendRecord$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'AppendRecord' from JSON`,
  );
}
