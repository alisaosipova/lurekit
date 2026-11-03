# ADR-0001: Language and runtime

Status: **accepted** (Alisa, 2026-11-01). Decision made ahead of the full SDD.

## Context
LureKit 0.1 must: drive agent CLIs headless, stand up inert fixture servers (incl. MCP stdio/HTTP), observe tool calls, run effect sensors, score, and emit JSON/Markdown/SARIF. An existing MIT codebase, `mcp-review-check` (TypeScript, Node >=20.19), already implements an MCP protocol client, fixture servers, and JSON/Markdown/SARIF reporters (landscape §3.2).

## Options
1. **TypeScript / Node >=20.19** — reuse the mcp-review-check protocol client, fixture servers, reporters, OIDC trusted-publishing release and 3-OS CI; npx distribution; MCP TypeScript SDK parity.
2. **Python** — closer to the research ecosystem (AgentDojo, CaMeL, promptfoo providers); but the reusable MCP client and fixture servers would be rewritten.
3. **Go** — single binary, convenient container/netns orchestration; loses all reuse and MCP SDK parity.

## Decision
TypeScript on Node >=20.19, matching mcp-review-check's engines and toolchain (vitest, tsc, SHA-pinned actions, OIDC release).

## Consequences
- Reuse: `src/protocol/*`, `test/fixtures/*-server.mjs`, `src/report/{json,markdown,sarif}.ts`, `.github/workflows/{ci,release}.yml`.
- Isolation (containers, egress proxy, optional network namespace) is driven by child processes and config, not a native library. Accepted; the runner shells out to the container runtime rather than binding libc.
- Agent SDKs: Claude Code and Codex ship TS SDKs; OpenHands is Python-only, so its adapter drives the CLI, not the SDK.
