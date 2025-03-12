/*
 * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { S2Core } from "../core.js";
import { SDKOptions } from "../lib/config.js";
import type { ConsoleLogger } from "./console-logger.js";
import {
  createRegisterResource,
  createRegisterResourceTemplate,
} from "./resources.js";
import { MCPScope, mcpScopes } from "./scopes.js";
import { createRegisterTool } from "./tools.js";
import { tool$accountCreateBasin } from "./tools/accountCreateBasin.js";
import { tool$accountDeleteBasin } from "./tools/accountDeleteBasin.js";
import { tool$accountGetBasinConfig } from "./tools/accountGetBasinConfig.js";
import { tool$accountListBasins } from "./tools/accountListBasins.js";
import { tool$accountReconfigureBasin } from "./tools/accountReconfigureBasin.js";
import { tool$basinCreateStream } from "./tools/basinCreateStream.js";
import { tool$basinDeleteStream } from "./tools/basinDeleteStream.js";
import { tool$basinGetStreamConfig } from "./tools/basinGetStreamConfig.js";
import { tool$basinListStreams } from "./tools/basinListStreams.js";
import { tool$basinReconfigureStream } from "./tools/basinReconfigureStream.js";
import { tool$streamAppend } from "./tools/streamAppend.js";
import { tool$streamCheckTail } from "./tools/streamCheckTail.js";
import { tool$streamRead } from "./tools/streamRead.js";

export function createMCPServer(deps: {
  logger: ConsoleLogger;
  allowedTools?: string[] | undefined;
  scopes?: MCPScope[] | undefined;
  serverURL?: string | undefined;
  bearerAuth?: SDKOptions["bearerAuth"] | undefined;
  serverIdx?: SDKOptions["serverIdx"] | undefined;
}) {
  const server = new McpServer({
    name: "S2",
    version: "0.8.1",
  });

  const client = new S2Core({
    bearerAuth: deps.bearerAuth,
    serverURL: deps.serverURL,
    serverIdx: deps.serverIdx,
  });

  const scopes = new Set(deps.scopes ?? mcpScopes);

  const allowedTools = deps.allowedTools && new Set(deps.allowedTools);
  const tool = createRegisterTool(
    deps.logger,
    server,
    client,
    scopes,
    allowedTools,
  );
  const resource = createRegisterResource(deps.logger, server, client, scopes);
  const resourceTemplate = createRegisterResourceTemplate(
    deps.logger,
    server,
    client,
    scopes,
  );
  const register = { tool, resource, resourceTemplate };
  void register; // suppress unused warnings

  tool(tool$accountListBasins);
  tool(tool$accountGetBasinConfig);
  tool(tool$accountCreateBasin);
  tool(tool$accountDeleteBasin);
  tool(tool$accountReconfigureBasin);
  tool(tool$basinListStreams);
  tool(tool$basinGetStreamConfig);
  tool(tool$basinCreateStream);
  tool(tool$basinDeleteStream);
  tool(tool$basinReconfigureStream);
  tool(tool$streamRead);
  tool(tool$streamAppend);
  tool(tool$streamCheckTail);

  return server;
}
