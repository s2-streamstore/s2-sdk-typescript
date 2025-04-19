/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import * as z from "zod";
import { safeParse } from "../../lib/schemas.js";
import { ClosedEnum } from "../../types/enums.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import {
  Output,
  Output$inboundSchema,
  Output$Outbound,
  Output$outboundSchema,
} from "./output.js";

export const ReadResponse3Event = {
  Ping: "ping",
} as const;
export type ReadResponse3Event = ClosedEnum<typeof ReadResponse3Event>;

export type Ping = {
  data: string;
  event: ReadResponse3Event;
};

export const ReadResponseEvent = {
  Error: "error",
} as const;
export type ReadResponseEvent = ClosedEnum<typeof ReadResponseEvent>;

export type ErrorT = {
  data: string;
  event: ReadResponseEvent;
};

export const Event = {
  Message: "message",
} as const;
export type Event = ClosedEnum<typeof Event>;

export type Message = {
  /**
   * Batch of records or the next sequence number on the stream.
   */
  data: Output;
  event: Event;
};

export type ReadResponse = Message | ErrorT | Ping;

/** @internal */
export const ReadResponse3Event$inboundSchema: z.ZodNativeEnum<
  typeof ReadResponse3Event
> = z.nativeEnum(ReadResponse3Event);

/** @internal */
export const ReadResponse3Event$outboundSchema: z.ZodNativeEnum<
  typeof ReadResponse3Event
> = ReadResponse3Event$inboundSchema;

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace ReadResponse3Event$ {
  /** @deprecated use `ReadResponse3Event$inboundSchema` instead. */
  export const inboundSchema = ReadResponse3Event$inboundSchema;
  /** @deprecated use `ReadResponse3Event$outboundSchema` instead. */
  export const outboundSchema = ReadResponse3Event$outboundSchema;
}

/** @internal */
export const Ping$inboundSchema: z.ZodType<Ping, z.ZodTypeDef, unknown> = z
  .object({
    data: z.string(),
    event: ReadResponse3Event$inboundSchema,
  });

/** @internal */
export type Ping$Outbound = {
  data: string;
  event: string;
};

/** @internal */
export const Ping$outboundSchema: z.ZodType<Ping$Outbound, z.ZodTypeDef, Ping> =
  z.object({
    data: z.string(),
    event: ReadResponse3Event$outboundSchema,
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
export const ReadResponseEvent$inboundSchema: z.ZodNativeEnum<
  typeof ReadResponseEvent
> = z.nativeEnum(ReadResponseEvent);

/** @internal */
export const ReadResponseEvent$outboundSchema: z.ZodNativeEnum<
  typeof ReadResponseEvent
> = ReadResponseEvent$inboundSchema;

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace ReadResponseEvent$ {
  /** @deprecated use `ReadResponseEvent$inboundSchema` instead. */
  export const inboundSchema = ReadResponseEvent$inboundSchema;
  /** @deprecated use `ReadResponseEvent$outboundSchema` instead. */
  export const outboundSchema = ReadResponseEvent$outboundSchema;
}

/** @internal */
export const ErrorT$inboundSchema: z.ZodType<ErrorT, z.ZodTypeDef, unknown> = z
  .object({
    data: z.string(),
    event: ReadResponseEvent$inboundSchema,
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
  event: ReadResponseEvent$outboundSchema,
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
export const Message$inboundSchema: z.ZodType<Message, z.ZodTypeDef, unknown> =
  z.object({
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
    }).pipe(Output$inboundSchema),
    event: Event$inboundSchema,
  });

/** @internal */
export type Message$Outbound = {
  data: Output$Outbound;
  event: string;
};

/** @internal */
export const Message$outboundSchema: z.ZodType<
  Message$Outbound,
  z.ZodTypeDef,
  Message
> = z.object({
  data: Output$outboundSchema,
  event: Event$outboundSchema,
});

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace Message$ {
  /** @deprecated use `Message$inboundSchema` instead. */
  export const inboundSchema = Message$inboundSchema;
  /** @deprecated use `Message$outboundSchema` instead. */
  export const outboundSchema = Message$outboundSchema;
  /** @deprecated use `Message$Outbound` instead. */
  export type Outbound = Message$Outbound;
}

export function messageToJSON(message: Message): string {
  return JSON.stringify(Message$outboundSchema.parse(message));
}

export function messageFromJSON(
  jsonString: string,
): SafeParseResult<Message, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => Message$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'Message' from JSON`,
  );
}

/** @internal */
export const ReadResponse$inboundSchema: z.ZodType<
  ReadResponse,
  z.ZodTypeDef,
  unknown
> = z.union([
  z.lazy(() => Message$inboundSchema),
  z.lazy(() => ErrorT$inboundSchema),
  z.lazy(() => Ping$inboundSchema),
]);

/** @internal */
export type ReadResponse$Outbound =
  | Message$Outbound
  | ErrorT$Outbound
  | Ping$Outbound;

/** @internal */
export const ReadResponse$outboundSchema: z.ZodType<
  ReadResponse$Outbound,
  z.ZodTypeDef,
  ReadResponse
> = z.union([
  z.lazy(() => Message$outboundSchema),
  z.lazy(() => ErrorT$outboundSchema),
  z.lazy(() => Ping$outboundSchema),
]);

/**
 * @internal
 * @deprecated This namespace will be removed in future versions. Use schemas and types that are exported directly from this module.
 */
export namespace ReadResponse$ {
  /** @deprecated use `ReadResponse$inboundSchema` instead. */
  export const inboundSchema = ReadResponse$inboundSchema;
  /** @deprecated use `ReadResponse$outboundSchema` instead. */
  export const outboundSchema = ReadResponse$outboundSchema;
  /** @deprecated use `ReadResponse$Outbound` instead. */
  export type Outbound = ReadResponse$Outbound;
}

export function readResponseToJSON(readResponse: ReadResponse): string {
  return JSON.stringify(ReadResponse$outboundSchema.parse(readResponse));
}

export function readResponseFromJSON(
  jsonString: string,
): SafeParseResult<ReadResponse, SDKValidationError> {
  return safeParse(
    jsonString,
    (x) => ReadResponse$inboundSchema.parse(JSON.parse(x)),
    `Failed to parse 'ReadResponse' from JSON`,
  );
}
