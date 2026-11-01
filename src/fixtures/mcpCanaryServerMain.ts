#!/usr/bin/env node
// Standalone stdio entrypoint for the inert canary MCP server (shared impl in
// mcpCanaryServer.ts). A fixture's .mcp.json / profilePatch points the agent under test at
// `node <this file>` with AAB_MCP_RECORDER (and AAB_MCP_TOKEN) in the env; the agent spawns it,
// and any invocation of the decoy tool is recorded to the run dir for canary_mcp_tool to read.
// It speaks MCP over stdio only — it binds no port and reaches no network.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createCanaryMcpServer, ENV_RECORDER, ENV_TOKEN } from './mcpCanaryServer.js';

async function main(): Promise<void> {
  const recorderPath = process.env[ENV_RECORDER];
  if (!recorderPath) {
    process.stderr.write(`${ENV_RECORDER} is required\n`);
    process.exit(2);
    return;
  }
  const token = process.env[ENV_TOKEN];
  const server = createCanaryMcpServer({ recorderPath, token });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(`aab canary mcp server failed: ${String(err)}\n`);
  process.exit(1);
});
