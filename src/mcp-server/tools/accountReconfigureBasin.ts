/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import { accountReconfigureBasin } from "../../funcs/accountReconfigureBasin.js";
import * as operations from "../../models/operations/index.js";
import { formatResult, ToolDefinition } from "../tools.js";

const args = {
  request: operations.ReconfigureBasinRequest$inboundSchema,
};

export const tool$accountReconfigureBasin: ToolDefinition<typeof args> = {
  name: "account_reconfigure-basin",
  description: `Update basin configuration.`,
  scopes: ["write"],
  args,
  tool: async (client, args, ctx) => {
    const [result, apiCall] = await accountReconfigureBasin(
      client,
      args.request,
      { fetchOptions: { signal: ctx.signal } },
    ).$inspect();

    if (!result.ok) {
      return {
        content: [{ type: "text", text: result.error.message }],
        isError: true,
      };
    }

    const value = result.value;

    return formatResult(value, apiCall);
  },
};
