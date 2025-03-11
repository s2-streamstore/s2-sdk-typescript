/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import * as z from "zod";
import { remap as remap$ } from "../../lib/primitives.js";
import { safeParse } from "../../lib/schemas.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import {
  StreamConfig,
  StreamConfig$inboundSchema,
  StreamConfig$Outbound,
  StreamConfig$outboundSchema,
} from "./streamconfig.js";

/**
 * Basin configuration.
 */
export type BasinConfig = {
  /**
   * Create stream on append if it doesn't exist,
   *
   * @remarks
   * using the default stream configuration.
   */
  createStreamOnAppend: boolean;
  defaultStreamConfig?: StreamConfig | null | undefined;
};

/** @internal */
export const BasinConfig$inboundSchema: z.ZodType<
  BasinConfig,
  z.ZodTypeDef,
  unknown
> = z.object({
  create_stream_on_append: z.boolean(),
  default_stream_config: z.nullable(StreamConfig$inboundSchema).optional(),
}).transform((v) => {
  return remap$(v, {
    "create_stream_on_append": "createStreamOnAppend",
    "default_stream_config": "defaultStreamConfig",
  });
});

/** @internal */
export type BasinConfig$Outbound = {
  create_stream_on_append: boolean;
  default_stream_config?: StreamConfig$Outbound | null | undefined;
};

/** @internal */
export const BasinConfig$outboundSchema: z.ZodType<
  BasinConfig$Outbound,
  z.ZodTypeDef,
  BasinConfig
> = z.object({
  createStreamOnAppend: z.boolean(),
  defaultStreamConfig: z.nullable(StreamConfig$outboundSchema).optional(),
}).transform((v) => {
  return remap$(v, {
    createStreamOnAppend: "create_stream_on_append",
    defaultStreamConfig: "default_stream_config",
  });
});

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace BasinConfig$ {
  /** @deprecated use `BasinConfig$inboundSchema` instead. */
  export const inboundSchema = BasinConfig$inboundSchema;
  /** @deprecated use `BasinConfig$outboundSchema` instead. */
  export const outboundSchema = BasinConfig$outboundSchema;
  /** @deprecated use `BasinConfig$Outbound` instead. */
  export type Outbound = BasinConfig$Outbound;
}

export function basinConfigToJSON(basinConfig: BasinConfig): string {
  return JSON.stringify(BasinConfig$outboundSchema.parse(basinConfig));
}

export function basinConfigFromJSON(
  jsonString: string,
): SafeParseResult<BasinConfig, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => BasinConfig$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'BasinConfig' from JSON`,
  );
}
