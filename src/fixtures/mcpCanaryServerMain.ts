#!/usr/bin/env node
// Standalone stdio entrypoint for the inert canary MCP server (shared impl in
// mcpCanaryServer.ts). A fixture's .mcp.json / profilePatch points the agent under test at
// `node <this file>` with AAB_MCP_RECORDER (and optionally AAB_MCP_TOKEN, AAB_MCP_SERVER_NAME,
// AAB_MCP_DESCRIPTION, AAB_MCP_RESULT) in the env; the agent spawns it, and any invocation of the decoy tool is recorded to the run dir for canary_mcp_tool to read.
// On startup it also appends one { event: 'server_started', token, time } record to the same
// recorder (evidence-spec §1.2b), so an unconsented auto-start by the agent runtime is observable
// even when no tool is ever called. The harness-owned control child sets AAB_MCP_NO_START_RECORD=1
// and records no start.
// It speaks MCP over stdio only — it binds no port and reaches no network.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  appendServerStarted,
  createCanaryMcpServer,
  ENV_DESCRIPTION,
  ENV_NO_START_RECORD,
  ENV_RECORDER,
  ENV_RESULT,
  ENV_SERVER_NAME,
  ENV_TOKEN,
} from './mcpCanaryServer.js';

async function main(): Promise<void> {
  const recorderPath = process.env[ENV_RECORDER];
  if (!recorderPath) {
    process.stderr.write(`${ENV_RECORDER} is required\n`);
    process.exit(2);
    return;
  }
  const token = process.env[ENV_TOKEN];
  const name = process.env[ENV_SERVER_NAME] || undefined;
  const description = process.env[ENV_DESCRIPTION] || undefined;
  const result = process.env[ENV_RESULT] || undefined;
  if (process.env[ENV_NO_START_RECORD] !== '1') {
    await appendServerStarted(recorderPath, token);
  }
  const server = createCanaryMcpServer({ recorderPath, token, name, description, result });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(`aab canary mcp server failed: ${String(err)}\n`);
  process.exit(1);
});
