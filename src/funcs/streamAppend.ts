/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import { S2Core } from "../core.js";
import { encodeJSON, encodeSimple } from "../lib/encodings.js";
import * as M from "../lib/matchers.js";
import { compactMap } from "../lib/primitives.js";
import { safeParse } from "../lib/schemas.js";
import { RequestOptions } from "../lib/sdks.js";
import { extractSecurity, resolveGlobalSecurity } from "../lib/security.js";
import { pathToFunc } from "../lib/url.js";
import * as components from "../models/components/index.js";
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
import { AppendServerList } from "../models/operations/append.js";
import * as operations from "../models/operations/index.js";
import { Result } from "../types/fp.js";

/**
 * Append records.
 *
 * @remarks
 * Append a batch of records to a stream.
 */
export async function streamAppend(
  client: S2Core,
  request: operations.AppendRequest,
  options?: RequestOptions,
): Promise<
  Result<
    components.AppendOutput,
    | errors.ErrorResponse
    | errors.ErrorResponse
    | APIError
    | SDKValidationError
    | UnexpectedClientError
    | InvalidRequestError
    | RequestAbortedError
    | RequestTimeoutError
    | ConnectionError
  >
> {
  const parsed = safeParse(
    request,
    (value) => operations.AppendRequest$outboundSchema.parse(value),
    "Input validation failed",
  );
  if (!parsed.ok) {
    return parsed;
  }
  const payload = parsed.value;
  const body = encodeJSON("body", payload.AppendInput, { explode: true });

  const baseURL = options?.serverURL
    || pathToFunc(AppendServerList[0], { charEncoding: "percent" })({
      basin: "my-favorite-basin",
    });

  const pathParams = {
    stream: encodeSimple("stream", payload.stream, {
      explode: false,
      charEncoding: "percent",
    }),
  };

  const path = pathToFunc("/streams/{stream}/records")(pathParams);

  const headers = new Headers(compactMap({
    "Content-Type": "application/json",
    Accept: "application/json",
    "s2-format": encodeSimple("s2-format", payload["s2-format"], {
      explode: false,
      charEncoding: "none",
    }),
  }));

  const secConfig = await extractSecurity(client._options.bearerAuth);
  const securityInput = secConfig == null ? {} : { bearerAuth: secConfig };
  const requestSecurity = resolveGlobalSecurity(securityInput);

  const context = {
    operationID: "append",
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
    method: "POST",
    baseURL: baseURL,
    path: path,
    headers: headers,
    body: body,
    timeoutMs: options?.timeoutMs || client._options.timeoutMs || -1,
  }, options);
  if (!requestRes.ok) {
    return requestRes;
  }
  const req = requestRes.value;

  const doResult = await client._do(req, {
    context,
    errorCodes: ["400", "401", "404", "4XX", "500", "5XX"],
    retryConfig: context.retryConfig,
    retryCodes: context.retryCodes,
  });
  if (!doResult.ok) {
    return doResult;
  }
  const response = doResult.value;

  const responseFields = {
    HttpMeta: { Response: response, Request: req },
  };

  const [result] = await M.match<
    components.AppendOutput,
    | errors.ErrorResponse
    | errors.ErrorResponse
    | APIError
    | SDKValidationError
    | UnexpectedClientError
    | InvalidRequestError
    | RequestAbortedError
    | RequestTimeoutError
    | ConnectionError
  >(
    M.json(200, components.AppendOutput$inboundSchema),
    M.jsonErr([400, 401, 404], errors.ErrorResponse$inboundSchema),
    M.jsonErr(500, errors.ErrorResponse$inboundSchema),
    M.fail("4XX"),
    M.fail("5XX"),
  )(response, { extraFields: responseFields });
  if (!result.ok) {
    return result;
  }

  return result;
}
