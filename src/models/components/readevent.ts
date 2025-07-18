/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import * as z from "zod";
import { safeParse } from "../../lib/schemas.js";
import { ClosedEnum } from "../../types/enums.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import {
  PingEventData,
  PingEventData$inboundSchema,
  PingEventData$Outbound,
  PingEventData$outboundSchema,
} from "./pingeventdata.js";
import {
  ReadBatch,
  ReadBatch$inboundSchema,
  ReadBatch$Outbound,
  ReadBatch$outboundSchema,
} from "./readbatch.js";

export const ReadEvent3Event = {
  Ping: "ping",
} as const;
export type ReadEvent3Event = ClosedEnum<typeof ReadEvent3Event>;

export type Ping = {
  data: PingEventData;
  event: ReadEvent3Event;
};

export const ReadEventEvent = {
  Error: "error",
} as const;
export type ReadEventEvent = ClosedEnum<typeof ReadEventEvent>;

export type ErrorT = {
  data: string;
  event: ReadEventEvent;
};

export const Event = {
  Batch: "batch",
} as const;
export type Event = ClosedEnum<typeof Event>;

export type Batch = {
  data: ReadBatch;
  event: Event;
  id: string;
};

export type ReadEvent = Batch | ErrorT | Ping;

/** @internal */
export const ReadEvent3Event$inboundSchema: z.ZodNativeEnum<
  typeof ReadEvent3Event
> = z.nativeEnum(ReadEvent3Event);

/** @internal */
export const ReadEvent3Event$outboundSchema: z.ZodNativeEnum<
  typeof ReadEvent3Event
> = ReadEvent3Event$inboundSchema;

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace ReadEvent3Event$ {
  /** @deprecated use `ReadEvent3Event$inboundSchema` instead. */
  export const inboundSchema = ReadEvent3Event$inboundSchema;
  /** @deprecated use `ReadEvent3Event$outboundSchema` instead. */
  export const outboundSchema = ReadEvent3Event$outboundSchema;
}

/** @internal */
export const Ping$inboundSchema: z.ZodType<Ping, z.ZodTypeDef, unknown> = z
  .object({
    data: z.string().transform((v, ctx) => {
      try {
        return JSON.parse(v);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `malformed json: ${err}`,
        });
        return z.NEVER;
      }
    }).pipe(PingEventData$inboundSchema),
    event: ReadEvent3Event$inboundSchema,
  });

/** @internal */
export type Ping$Outbound = {
  data: PingEventData$Outbound;
  event: string;
};

/** @internal */
export const Ping$outboundSchema: z.ZodType<Ping$Outbound, z.ZodTypeDef, Ping> =
  z.object({
    data: PingEventData$outboundSchema,
    event: ReadEvent3Event$outboundSchema,
  });

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace Ping$ {
  /** @deprecated use `Ping$inboundSchema` instead. */
  export const inboundSchema = Ping$inboundSchema;
  /** @deprecated use `Ping$outboundSchema` instead. */
  export const outboundSchema = Ping$outboundSchema;
  /** @deprecated use `Ping$Outbound` instead. */
  export type Outbound = Ping$Outbound;
}

export function pingToJSON(ping: Ping): string {
  return JSON.stringify(Ping$outboundSchema.parse(ping));
}

export function pingFromJSON(
  jsonString: string,
): SafeParseResult<Ping, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => Ping$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'Ping' from JSON`,
  );
}

/** @internal */
export const ReadEventEvent$inboundSchema: z.ZodNativeEnum<
  typeof ReadEventEvent
> = z.nativeEnum(ReadEventEvent);

/** @internal */
export const ReadEventEvent$outboundSchema: z.ZodNativeEnum<
  typeof ReadEventEvent
> = ReadEventEvent$inboundSchema;

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace ReadEventEvent$ {
  /** @deprecated use `ReadEventEvent$inboundSchema` instead. */
  export const inboundSchema = ReadEventEvent$inboundSchema;
  /** @deprecated use `ReadEventEvent$outboundSchema` instead. */
  export const outboundSchema = ReadEventEvent$outboundSchema;
}

/** @internal */
export const ErrorT$inboundSchema: z.ZodType<ErrorT, z.ZodTypeDef, unknown> = z
  .object({
    data: z.string(),
    event: ReadEventEvent$inboundSchema,
  });

/** @internal */
export type ErrorT$Outbound = {
  data: string;
  event: string;
};

/** @internal */
export const ErrorT$outboundSchema: z.ZodType<
  ErrorT$Outbound,
  z.ZodTypeDef,
  ErrorT
> = z.object({
  data: z.string(),
  event: ReadEventEvent$outboundSchema,
});

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace ErrorT$ {
  /** @deprecated use `ErrorT$inboundSchema` instead. */
  export const inboundSchema = ErrorT$inboundSchema;
  /** @deprecated use `ErrorT$outboundSchema` instead. */
  export const outboundSchema = ErrorT$outboundSchema;
  /** @deprecated use `ErrorT$Outbound` instead. */
  export type Outbound = ErrorT$Outbound;
}

export function errorToJSON(errorT: ErrorT): string {
  return JSON.stringify(ErrorT$outboundSchema.parse(errorT));
}

export function errorFromJSON(
  jsonString: string,
): SafeParseResult<ErrorT, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => ErrorT$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'ErrorT' from JSON`,
  );
}

/** @internal */
export const Event$inboundSchema: z.ZodNativeEnum<typeof Event> = z.nativeEnum(
  Event,
);

/** @internal */
export const Event$outboundSchema: z.ZodNativeEnum<typeof Event> =
  Event$inboundSchema;

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace Event$ {
  /** @deprecated use `Event$inboundSchema` instead. */
  export const inboundSchema = Event$inboundSchema;
  /** @deprecated use `Event$outboundSchema` instead. */
  export const outboundSchema = Event$outboundSchema;
}

/** @internal */
export const Batch$inboundSchema: z.ZodType<Batch, z.ZodTypeDef, unknown> = z
  .object({
    data: z.string().transform((v, ctx) => {
      try {
        return JSON.parse(v);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `malformed json: ${err}`,
        });
        return z.NEVER;
      }
    }).pipe(ReadBatch$inboundSchema),
    event: Event$inboundSchema,
    id: z.string(),
  });

/** @internal */
export type Batch$Outbound = {
  data: ReadBatch$Outbound;
  event: string;
  id: string;
};

/** @internal */
export const Batch$outboundSchema: z.ZodType<
  Batch$Outbound,
  z.ZodTypeDef,
  Batch
> = z.object({
  data: ReadBatch$outboundSchema,
  event: Event$outboundSchema,
  id: z.string(),
});

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace Batch$ {
  /** @deprecated use `Batch$inboundSchema` instead. */
  export const inboundSchema = Batch$inboundSchema;
  /** @deprecated use `Batch$outboundSchema` instead. */
  export const outboundSchema = Batch$outboundSchema;
  /** @deprecated use `Batch$Outbound` instead. */
  export type Outbound = Batch$Outbound;
}

export function batchToJSON(batch: Batch): string {
  return JSON.stringify(Batch$outboundSchema.parse(batch));
}

export function batchFromJSON(
  jsonString: string,
): SafeParseResult<Batch, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => Batch$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'Batch' from JSON`,
  );
}

/** @internal */
export const ReadEvent$inboundSchema: z.ZodType<
  ReadEvent,
  z.ZodTypeDef,
  unknown
> = z.union([
  z.lazy(() => Batch$inboundSchema),
  z.lazy(() => ErrorT$inboundSchema),
  z.lazy(() => Ping$inboundSchema),
]);

/** @internal */
export type ReadEvent$Outbound =
  | Batch$Outbound
  | ErrorT$Outbound
  | Ping$Outbound;

/** @internal */
export const ReadEvent$outboundSchema: z.ZodType<
  ReadEvent$Outbound,
  z.ZodTypeDef,
  ReadEvent
> = z.union([
  z.lazy(() => Batch$outboundSchema),
  z.lazy(() => ErrorT$outboundSchema),
  z.lazy(() => Ping$outboundSchema),
]);

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace ReadEvent$ {
  /** @deprecated use `ReadEvent$inboundSchema` instead. */
  export const inboundSchema = ReadEvent$inboundSchema;
  /** @deprecated use `ReadEvent$outboundSchema` instead. */
  export const outboundSchema = ReadEvent$outboundSchema;
  /** @deprecated use `ReadEvent$Outbound` instead. */
  export type Outbound = ReadEvent$Outbound;
}

export function readEventToJSON(readEvent: ReadEvent): string {
  return JSON.stringify(ReadEvent$outboundSchema.parse(readEvent));
}

export function readEventFromJSON(
  jsonString: string,
): SafeParseResult<ReadEvent, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => ReadEvent$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'ReadEvent' from JSON`,
  );
}
