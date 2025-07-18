/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import * as z from "zod";
import { remap as remap$ } from "../../lib/primitives.js";
import { safeParse } from "../../lib/schemas.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import {
  RetentionPolicy,
  RetentionPolicy$inboundSchema,
  RetentionPolicy$Outbound,
  RetentionPolicy$outboundSchema,
} from "./retentionpolicy.js";
import {
  StorageClass,
  StorageClass$inboundSchema,
  StorageClass$outboundSchema,
} from "./storageclass.js";
import {
  TimestampingConfig,
  TimestampingConfig$inboundSchema,
  TimestampingConfig$Outbound,
  TimestampingConfig$outboundSchema,
} from "./timestampingconfig.js";

export type StreamConfig = {
  retentionPolicy?: RetentionPolicy | null | undefined;
  storageClass?: StorageClass | null | undefined;
  timestamping?: TimestampingConfig | null | undefined;
};

/** @internal */
export const StreamConfig$inboundSchema: z.ZodType<
  StreamConfig,
  z.ZodTypeDef,
  unknown
> = z.object({
  retention_policy: z.nullable(RetentionPolicy$inboundSchema).optional(),
  storage_class: z.nullable(StorageClass$inboundSchema).optional(),
  timestamping: z.nullable(TimestampingConfig$inboundSchema).optional(),
}).transform((v) => {
  return remap$(v, {
    "retention_policy": "retentionPolicy",
    "storage_class": "storageClass",
  });
});

/** @internal */
export type StreamConfig$Outbound = {
  retention_policy?: RetentionPolicy$Outbound | null | undefined;
  storage_class?: string | null | undefined;
  timestamping?: TimestampingConfig$Outbound | null | undefined;
};

/** @internal */
export const StreamConfig$outboundSchema: z.ZodType<
  StreamConfig$Outbound,
  z.ZodTypeDef,
  StreamConfig
> = z.object({
  retentionPolicy: z.nullable(RetentionPolicy$outboundSchema).optional(),
  storageClass: z.nullable(StorageClass$outboundSchema).optional(),
  timestamping: z.nullable(TimestampingConfig$outboundSchema).optional(),
}).transform((v) => {
  return remap$(v, {
    retentionPolicy: "retention_policy",
    storageClass: "storage_class",
  });
});

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace StreamConfig$ {
  /** @deprecated use `StreamConfig$inboundSchema` instead. */
  export const inboundSchema = StreamConfig$inboundSchema;
  /** @deprecated use `StreamConfig$outboundSchema` instead. */
  export const outboundSchema = StreamConfig$outboundSchema;
  /** @deprecated use `StreamConfig$Outbound` instead. */
  export type Outbound = StreamConfig$Outbound;
}

export function streamConfigToJSON(streamConfig: StreamConfig): string {
  return JSON.stringify(StreamConfig$outboundSchema.parse(streamConfig));
}

export function streamConfigFromJSON(
  jsonString: string,
): SafeParseResult<StreamConfig, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => StreamConfig$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'StreamConfig' from JSON`,
  );
}
