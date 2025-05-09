/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import { recordsCheckTail } from "../funcs/recordsCheckTail.js";
import { ClientSDK, RequestOptions } from "../lib/sdks.js";
import * as components from "../models/components/index.js";
import * as operations from "../models/operations/index.js";
import { unwrapAsync } from "../types/fp.js";

export class Records extends ClientSDK {
  /**
   * Check the tail.
   *
   * @remarks
   * Check the tail of a stream.
   */
  async checkTail(
    request: operations.CheckTailRequest,
    options?: RequestOptions,
  ): Promise<components.CheckTailResponse> {
    return unwrapAsync(recordsCheckTail(
      this,
      request,
      options,
    ));
  }
}
