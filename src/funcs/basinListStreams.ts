/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import jp from "jsonpath";
import { S2Core } from "../core.js";
import { encodeFormQuery } from "../lib/encodings.js";
import * as M from "../lib/matchers.js";
import { compactMap } from "../lib/primitives.js";
import { safeParse } from "../lib/schemas.js";
import { RequestOptions } from "../lib/sdks.js";
import { extractSecurity, resolveGlobalSecurity } from "../lib/security.js";
import { pathToFunc } from "../lib/url.js";
import { APIError } from "../models/errors/apierror.js";
import {
  ConnectionError,
  InvalidRequestError,
  RequestAbortedError,
  RequestTimeoutError,
  UnexpectedClientError,
} from "../models/errors/httpclienterrors.js";
import * as errors from "../models/errors/index.js";
import { SDKValidationError } from "../models/errors/sdkvalidationerror.js";
import * as operations from "../models/operations/index.js";
import { ListStreamsServerList } from "../models/operations/liststreams.js";
import { APICall, APIPromise } from "../types/async.js";
import { Result } from "../types/fp.js";
import {
  createPageIterator,
  haltIterator,
  PageIterator,
  Paginator,
} from "../types/operations.js";

/**
 * List Streams.
 */
export function basinListStreams(
  client: S2Core,
  request: operations.ListStreamsRequest,
  options?: RequestOptions,
): APIPromise<
  PageIterator<
    Result<
      operations.ListStreamsResponse,
      | errors.ErrorResponse
      | errors.RetryableError
      | errors.RetryableError
      | APIError
      | SDKValidationError
      | UnexpectedClientError
      | InvalidRequestError
      | RequestAbortedError
      | RequestTimeoutError
      | ConnectionError
    >,
    { cursor: string }
  >
> {
  return new APIPromise($do(
    client,
    request,
    options,
  ));
}

async function $do(
  client: S2Core,
  request: operations.ListStreamsRequest,
  options?: RequestOptions,
): Promise<
  [
    PageIterator<
      Result<
        operations.ListStreamsResponse,
        | errors.ErrorResponse
        | errors.RetryableError
        | errors.RetryableError
        | APIError
        | SDKValidationError
        | UnexpectedClientError
        | InvalidRequestError
        | RequestAbortedError
        | RequestTimeoutError
        | ConnectionError
      >,
      { cursor: string }
    >,
    APICall,
  ]
> {
  const parsed = safeParse(
    request,
    (value) => operations.ListStreamsRequest$outboundSchema.parse(value),
    "Input validation failed",
  );
  if (!parsed.ok) {
    return [haltIterator(parsed), { status: "invalid" }];
  }
  const payload = parsed.value;
  const body = null;

  const baseURL = options?.serverURL
    || pathToFunc(ListStreamsServerList[0], { charEncoding: "percent" })({
      basin: "my-favorite-basin",
    });

  const path = pathToFunc("/streams")();

  const query = encodeFormQuery({
    "limit": payload.limit,
    "prefix": payload.prefix,
    "start_after": payload.start_after,
  });

  const headers = new Headers(compactMap({
    Accept: "application/json",
  }));

  const secConfig = await extractSecurity(client._options.bearerAuth);
  const securityInput = secConfig == null ? {} : { bearerAuth: secConfig };
  const requestSecurity = resolveGlobalSecurity(securityInput);

  const context = {
    baseURL: baseURL ?? "",
    operationID: "list_streams",
    oAuth2Scopes: [],

    resolvedSecurity: requestSecurity,

    securitySource: client._options.bearerAuth,
    retryConfig: options?.retries
      || client._options.retryConfig
      || { strategy: "none" },
    retryCodes: options?.retryCodes || ["429", "500", "502", "503", "504"],
  };

  const requestRes = client._createRequest(context, {
    security: requestSecurity,
    method: "GET",
    baseURL: baseURL,
    path: path,
    headers: headers,
    query: query,
    body: body,
    timeoutMs: options?.timeoutMs || client._options.timeoutMs || -1,
  }, options);
  if (!requestRes.ok) {
    return [haltIterator(requestRes), { status: "invalid" }];
  }
  const req = requestRes.value;

  const doResult = await client._do(req, {
    context,
    errorCodes: ["400", "401", "499", "4XX", "500", "503", "504", "5XX"],
    retryConfig: context.retryConfig,
    retryCodes: context.retryCodes,
  });
  if (!doResult.ok) {
    return [haltIterator(doResult), { status: "request-error", request: req }];
  }
  const response = doResult.value;

  const responseFields = {
    HttpMeta: { Response: response, Request: req },
  };

  const [result, raw] = await M.match<
    operations.ListStreamsResponse,
    | errors.ErrorResponse
    | errors.RetryableError
    | errors.RetryableError
    | APIError
    | SDKValidationError
    | UnexpectedClientError
    | InvalidRequestError
    | RequestAbortedError
    | RequestTimeoutError
    | ConnectionError
  >(
    M.json(200, operations.ListStreamsResponse$inboundSchema, {
      key: "Result",
    }),
    M.jsonErr([400, 401], errors.ErrorResponse$inboundSchema),
    M.jsonErr(499, errors.RetryableError$inboundSchema),
    M.jsonErr([500, 503, 504], errors.RetryableError$inboundSchema),
    M.fail("4XX"),
    M.fail("5XX"),
  )(response, { extraFields: responseFields });
  if (!result.ok) {
    return [haltIterator(result), {
      status: "complete",
      request: req,
      response,
    }];
  }

  const nextFunc = (
    responseData: unknown,
  ): {
    next: Paginator<
      Result<
        operations.ListStreamsResponse,
        | errors.ErrorResponse
        | errors.RetryableError
        | errors.RetryableError
        | APIError
        | SDKValidationError
        | UnexpectedClientError
        | InvalidRequestError
        | RequestAbortedError
        | RequestTimeoutError
        | ConnectionError
      >
    >;
    "~next"?: { cursor: string };
  } => {
    const nextCursor = jp.value(responseData, "$.streams[(@.length-1)].name");
    if (nextCursor == null) {
      return { next: () => null };
    }

    const nextVal = () =>
      basinListStreams(
        client,
        {
          ...request,
          startAfter: nextCursor,
        },
        options,
      );

    return { next: nextVal, "~next": { cursor: nextCursor } };
  };

  const page = { ...result, ...nextFunc(raw) };
  return [{ ...page, ...createPageIterator(page, (v) => !v.ok) }, {
    status: "complete",
    request: req,
    response,
  }];
}
