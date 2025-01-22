/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import * as z from "zod";
import { ClosedEnum } from "../../types/enums.js";

/**
 * Current state of the basin.
 */
export const BasinState = {
  Unspecified: "unspecified",
  Active: "active",
  Creating: "creating",
  Deleting: "deleting",
} as const;
/**
 * Current state of the basin.
 */
export type BasinState = ClosedEnum<typeof BasinState>;

/** @internal */
export const BasinState$inboundSchema: z.ZodNativeEnum<typeof BasinState> = z
  .nativeEnum(BasinState);

/** @internal */
export const BasinState$outboundSchema: z.ZodNativeEnum<typeof BasinState> =
  BasinState$inboundSchema;

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace BasinState$ {
  /** @deprecated use `BasinState$inboundSchema` instead. */
  export const inboundSchema = BasinState$inboundSchema;
  /** @deprecated use `BasinState$outboundSchema` instead. */
  export const outboundSchema = BasinState$outboundSchema;
}
