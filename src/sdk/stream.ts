/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import { streamAppend } from "../funcs/streamAppend.js";
import { streamCheckTail } from "../funcs/streamCheckTail.js";
import { streamRead } from "../funcs/streamRead.js";
import { ClientSDK, RequestOptions } from "../lib/sdks.js";
import * as components from "../models/components/index.js";
import * as operations from "../models/operations/index.js";
import { unwrapAsync } from "../types/fp.js";

export class Stream extends ClientSDK {
  /**
   * Retrieve a batch of records.
   */
  async read(
    request: operations.ReadRequest,
    options?: RequestOptions,
  ): Promise<components.Output> {
    return unwrapAsync(streamRead(
      this,
      request,
      options,
    ));
  }

  /**
   * Append a batch of records.
   */
  async append(
    request: operations.AppendRequest,
    options?: RequestOptions,
  ): Promise<components.AppendOutput> {
    return unwrapAsync(streamAppend(
      this,
      request,
      options,
    ));
  }

  /**
   * Check the tail.
   */
  async checkTail(
    request: operations.CheckTailRequest,
    options?: RequestOptions,
  ): Promise<components.CheckTailResponse> {
    return unwrapAsync(streamCheckTail(
      this,
      request,
      options,
    ));
  }
}
