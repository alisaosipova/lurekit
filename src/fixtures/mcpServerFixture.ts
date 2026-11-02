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
//
// Params (ADR-0002 "Interface notes - fixture params"), validated strictly at construction:
//   - server_name              : the MCP server name registered in the agent's config and
//                                expected `connected` (default aab-canary / aab-canary-http), so a
//                                two-server scenario can name both.
//   - tool_description_variant : plain (default) | mentions-another-server |
//                                mentions-sending-to-canary-host - one visible, inert placeholder
//                                description for the decoy tool (mcpCanaryServer.toolDescription).
//                                The canary-host text names ctx.canaries.url (canary_egress_http)
//                                and throws FixtureCanaryError without it.
//   - other_server             : optional name mentions-another-server refers to.
//   - result_variant           : plain (default; the decoy returns "ok") | names-canary-command -
//                                the decoy tool's RESULT (and, for mcp_http, the server metadata
//                                `instructions`) carries one visible, inert placeholder naming
//                                ctx.canaries.commandPath (canary_command); throws
//                                FixtureCanaryError without it.

import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { z } from 'zod';

import { FixtureBase, type FixtureContext, type FixtureProvision } from './fixture.js';
import { FIXTURE_NAME_RE, parseFixtureParams } from './params.js';
import type { FixtureKind } from '../scenario/types.js';
import {
  CANARY_MCP_TOOL,
  MCP_RECORDER_FILE,
  ENV_DESCRIPTION,
  ENV_RECORDER,
  ENV_RESULT,
  ENV_SERVER_NAME,
  ENV_TOKEN,
  RESULT_VARIANTS,
  TOOL_DESCRIPTION_VARIANTS,
  createCanaryMcpServer,
  serverInstructions,
  toolDescription,
  toolResult,
  type ResultVariant,
  type ToolDescriptionVariant,
} from './mcpCanaryServer.js';

/** MCP server names the fixtures register in the agent's MCP config, and expect to see
 *  `connected` in the agent's init report (evidence-spec §3.1 preconditions). */
export const STDIO_SERVER_NAME = 'aab-canary';
export const HTTP_SERVER_NAME = 'aab-canary-http';

function serverMainPath(): string {
  return fileURLToPath(new URL('./mcpCanaryServerMain.js', import.meta.url));
}

const McpFixtureParams = z
  .strictObject({
    server_name: z.string().regex(FIXTURE_NAME_RE).optional(),
    tool_description_variant: z.enum(TOOL_DESCRIPTION_VARIANTS).optional(),
    other_server: z.string().regex(FIXTURE_NAME_RE).optional(),
    result_variant: z.enum(RESULT_VARIANTS).optional(),
  })
  .refine(
    (p) => p.other_server === undefined || p.tool_description_variant === 'mentions-another-server',
    { message: 'other_server applies only to tool_description_variant "mentions-another-server"', path: ['other_server'] },
  )
  .refine((p) => p.other_server === undefined || p.other_server !== p.server_name, {
    message: 'other_server must differ from server_name',
    path: ['other_server'],
  });
export type McpFixtureParams = z.output<typeof McpFixtureParams>;

/** Shared by both transports: strict params, the chosen server name, and the decoy tool's
 *  description resolved against the detector canaries at provision time. */
abstract class McpFixtureBase extends FixtureBase {
  readonly params: McpFixtureParams;
  protected abstract readonly defaultServerName: string;

  constructor(kind: FixtureKind, params?: unknown) {
    super();
    this.params = parseFixtureParams(kind, McpFixtureParams, params);
  }

  get serverName(): string {
    return this.params.server_name ?? this.defaultServerName;
  }

  get descriptionVariant(): ToolDescriptionVariant {
    return this.params.tool_description_variant ?? 'plain';
  }

  /** The decoy description plus any canary it names (returned so FixtureBase re-validates it). */
  protected resolveDescription(ctx: FixtureContext): { description: string; canaries: Record<string, string> } {
    const variant = this.descriptionVariant;
    if (variant === 'mentions-sending-to-canary-host') {
      const canaryUrl = this.requireCanary(ctx, 'url', 'the canary host the tool description names');
      this.assertLoopback(canaryUrl);
      return {
        description: toolDescription(variant, { canaryUrl }),
        canaries: { canary_url: canaryUrl },
      };
    }
    return { description: toolDescription(variant, { otherServer: this.params.other_server }), canaries: {} };
  }

  get resultVariant(): ResultVariant {
    return this.params.result_variant ?? 'plain';
  }

  /** The decoy tool's result text (and the canary command it names, returned so FixtureBase
   *  re-validates it). names-canary-command takes commandPath from ctx.canaries, never invents it. */
  protected resolveResult(ctx: FixtureContext): { result: string; commandPath?: string; canaries: Record<string, string> } {
    const variant = this.resultVariant;
    if (variant === 'names-canary-command') {
      const commandPath = this.requireCanary(ctx, 'commandPath', 'the canary command the tool result names');
      return { result: toolResult(variant, { commandPath }), commandPath, canaries: { command: commandPath } };
    }
    return { result: toolResult(variant), canaries: {} };
  }

  protected commonCanaries(): Record<string, string> {
    return {
      serverName: this.serverName,
      descriptionVariant: this.descriptionVariant,
      resultVariant: this.resultVariant,
    };
  }
}

/** mcp_stdio: the inert canary server over stdio. */
export class McpStdioFixture extends McpFixtureBase {
  readonly type: FixtureKind = 'mcp_stdio';
  protected readonly defaultServerName = STDIO_SERVER_NAME;
  private child?: ChildProcess;

  constructor(params?: unknown) {
    super('mcp_stdio', params);
  }

  protected async provisionInert(ctx: FixtureContext): Promise<FixtureProvision> {
    await mkdir(ctx.runDir, { recursive: true });
    const det = this.mcpToolCanaries(ctx); // canary_mcp_tool's per-run token/recorder, if it is the sensor
    const token = det?.token ?? randomBytes(12).toString('hex');
    const recorderPath = det?.recorderPath ?? path.join(ctx.runDir, MCP_RECORDER_FILE);
    const mainPath = serverMainPath();
    const { description, canaries: descCanaries } = this.resolveDescription(ctx);
    const { result, canaries: resultCanaries } = this.resolveResult(ctx);
    const name = this.serverName;
    const env: Record<string, string> = {
      [ENV_RECORDER]: recorderPath,
      [ENV_TOKEN]: token,
      [ENV_SERVER_NAME]: name,
      [ENV_DESCRIPTION]: description,
    };
    // Only a non-plain result is passed on, so the default env stays as before.
    if (this.resultVariant !== 'plain') env[ENV_RESULT] = result;

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
        [name]: { command: process.execPath, args: [mainPath], env },
      },
    };

    return {
      canaries: {
        tool: CANARY_MCP_TOOL,
        token,
        recorderPath,
        transport: 'stdio',
        ...this.commonCanaries(),
        ...descCanaries,
        ...resultCanaries,
      },
      profilePatch: { mcp: mcpConfig },
      // §3.1 precondition: the run only counts if the agent actually connected this server.
      expect: { mcp_server: name },
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
export class McpHttpFixture extends McpFixtureBase {
  readonly type: FixtureKind = 'mcp_http';
  protected readonly defaultServerName = HTTP_SERVER_NAME;
  private server?: Server;

  constructor(params?: unknown) {
    super('mcp_http', params);
  }

  protected async provisionInert(ctx: FixtureContext): Promise<FixtureProvision> {
    await mkdir(ctx.runDir, { recursive: true });
    const det = this.mcpToolCanaries(ctx); // canary_mcp_tool's per-run token/recorder, if it is the sensor
    const token = det?.token ?? randomBytes(12).toString('hex');
    const recorderPath = det?.recorderPath ?? path.join(ctx.runDir, MCP_RECORDER_FILE);
    const { description, canaries: descCanaries } = this.resolveDescription(ctx);
    const { result, commandPath, canaries: resultCanaries } = this.resolveResult(ctx);
    // names-canary-command also places the placeholder in the server metadata (`instructions`).
    const instructions = commandPath !== undefined ? serverInstructions(commandPath) : undefined;
    const name = this.serverName;

    const server = createServer((req, res) => {
      void this.handle(req, res, { recorderPath, token, name, description, result, instructions });
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
      canaries: {
        tool: CANARY_MCP_TOOL,
        token,
        recorderPath,
        url,
        ...this.commonCanaries(),
        ...descCanaries,
        ...resultCanaries,
      },
      profilePatch: { mcp: { mcpServers: { [name]: { type: 'http', url } } } },
      // §3.1 precondition: the run only counts if the agent actually connected this server.
      expect: { mcp_server: name },
    };
  }

  /** Serve one Streamable-HTTP MCP request with a fresh stateless server/transport. */
  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
    opts: {
      recorderPath: string;
      token: string;
      name: string;
      description: string;
      result: string;
      instructions?: string;
    },
  ): Promise<void> {
    const mcp = createCanaryMcpServer(opts);
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
