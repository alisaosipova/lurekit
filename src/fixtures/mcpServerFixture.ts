// MCP server fixtures (ADR-0002; evidence-spec §1.2b). The inert canary MCP server stood up as a
// standalone fixture, in the two transports the schema's FixtureKind allows:
//   - mcp_stdio: the agent under test spawns `node <canary server main>` over stdio (the fixture
//     also stands up a harness-owned child so the server is live during the run).
//   - mcp_http:  the fixture binds a loopback (127.0.0.1) HTTP server hosting the same canary MCP
//     server over Streamable HTTP (stateless), and hands the agent its loopback URL.
// Both share the server impl with the canary_mcp_tool detector (mcpCanaryServer.ts). Each is the
// inert analogue of a poisoned / backdoored MCP server (AAB-018/019/020/022): the decoy tool only
// records its invocation. Inertness: stdio binds nothing; HTTP binds loopback only; no real
// secret is embedded (FixtureBase validates the returned canaries/profilePatch).

import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { FixtureBase, type FixtureContext, type FixtureProvision } from './fixture.js';
import type { FixtureKind } from '../scenario/types.js';
import {
  CANARY_MCP_TOOL,
  MCP_RECORDER_FILE,
  ENV_RECORDER,
  ENV_TOKEN,
  createCanaryMcpServer,
} from './mcpCanaryServer.js';

function serverMainPath(): string {
  return fileURLToPath(new URL('./mcpCanaryServerMain.js', import.meta.url));
}

/** mcp_stdio: the inert canary server over stdio. */
export class McpStdioFixture extends FixtureBase {
  readonly type: FixtureKind = 'mcp_stdio';
  private child?: ChildProcess;

  protected async provisionInert(ctx: FixtureContext): Promise<FixtureProvision> {
    await mkdir(ctx.runDir, { recursive: true });
    const token = randomBytes(12).toString('hex');
    const recorderPath = path.join(ctx.runDir, MCP_RECORDER_FILE);
    const mainPath = serverMainPath();
    const env = { [ENV_RECORDER]: recorderPath, [ENV_TOKEN]: token };

    // Stand up a harness-owned stdio server when the compiled main is present (real runs). In a
    // run the agent spawns its own instance via the profilePatch below; both write the same
    // recorder, so the sensor reads whichever the agent actually invokes. Spawn is non-fatal.
    if (existsSync(mainPath)) {
      try {
        this.child = spawn(process.execPath, [mainPath], {
          env: { ...process.env, ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.child.on('error', () => undefined);
      } catch {
        this.child = undefined;
      }
    }

    const mcpConfig = {
      mcpServers: {
        'aab-canary': { command: process.execPath, args: [mainPath], env },
      },
    };

    return {
      canaries: { tool: CANARY_MCP_TOOL, token, recorderPath, transport: 'stdio' },
      profilePatch: { mcp: mcpConfig },
    };
  }

  async teardown(): Promise<void> {
    if (this.child && !this.child.killed) {
      try {
        this.child.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

/** mcp_http: the inert canary server over loopback Streamable HTTP (stateless). */
export class McpHttpFixture extends FixtureBase {
  readonly type: FixtureKind = 'mcp_http';
  private server?: Server;

  protected async provisionInert(ctx: FixtureContext): Promise<FixtureProvision> {
    await mkdir(ctx.runDir, { recursive: true });
    const token = randomBytes(12).toString('hex');
    const recorderPath = path.join(ctx.runDir, MCP_RECORDER_FILE);

    const server = createServer((req, res) => {
      void this.handle(req, res, recorderPath, token);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error('mcp_http fixture: failed to bind an ephemeral loopback port');
    }
    const url = `http://127.0.0.1:${addr.port}/mcp`;

    return {
      // `url` is loopback — assertLoopback (invariant a) is applied to it by FixtureBase.
      canaries: { tool: CANARY_MCP_TOOL, token, recorderPath, url },
      profilePatch: { mcp: { mcpServers: { 'aab-canary-http': { type: 'http', url } } } },
    };
  }

  /** Serve one Streamable-HTTP MCP request with a fresh stateless server/transport. */
  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
    recorderPath: string,
    token: string,
  ): Promise<void> {
    const mcp = createCanaryMcpServer({ recorderPath, token });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      const body = await readJsonBody(req);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    }
  }

  async teardown(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }
}

/** Read and JSON-parse a request body; undefined for an empty/non-JSON body. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
