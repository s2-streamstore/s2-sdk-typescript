/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import { basinGetStreamConfig } from "../../funcs/basinGetStreamConfig.js";
import * as operations from "../../models/operations/index.js";
import { formatResult, ToolDefinition } from "../tools.js";

const args = {
  request: operations.GetStreamConfigRequest$inboundSchema,
};

export const tool$basinGetStreamConfig: ToolDefinition<typeof args> = {
  name: "basin-get-stream-config",
  description: `Get stream configuration.`,
  scopes: ["read"],
  args,
  tool: async (client, args, ctx) => {
    const [result, apiCall] = await basinGetStreamConfig(
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
