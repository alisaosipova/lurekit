#!/usr/bin/env node
// Offline stub for the `claude` binary, used only by test/claude-adapter.test.ts.
// It NEVER touches the network, spends no API, and is fully deterministic: all ids are fixed
// canaries, no Date.now()/Math.random() in the stream content. It emulates just enough of
// `claude -p --output-format stream-json --verbose` to exercise the adapter's plumbing:
//   1. answers `--version` with a canned version string;
//   2. records the argv it received (so the test can assert argv construction);
//   3. prints a system/init line, one assistant tool_use, and a result with total_cost_usd;
//   4. fires the installed PreToolUse hook with a synthetic payload whose tool_use_id matches
//      the stream's tool_use id — exercising the REAL hook plumbing end to end;
//   5. optionally hangs (AAB_STUB_HANG=1) so the test can prove the AbortSignal kills it;
//   6. optionally emulates a permission-gate denial (AAB_STUB_DENY=1, evidence-spec §4.2
//      "Attempts"): the tool_use's command becomes the task text (`-p` value), a user
//      tool_result for it carries is_error:true, and the result event lists it under
//      permission_denials. Nothing is executed either way; the stub never runs a command.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);

// 1. --version fast path (the adapter calls this before launch).
if (argv.includes('--version')) {
  process.stdout.write('2.1.309 (Claude Code)\n');
  process.exit(0);
}

// 2. Record argv for the test to assert on (path provided by the adapter's merged env).
const argvOut = process.env.AAB_STUB_ARGV_OUT;
if (argvOut) {
  try {
    fs.writeFileSync(argvOut, JSON.stringify(argv), 'utf8');
  } catch {
    /* ignore */
  }
}

function flagVal(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

// 2b. ADR-0020: echo the parsed `--settings` body the stub received (AAB_STUB_SETTINGS_OUT), so
//     a test can prove forwarded profile settings actually reached the agent process.
const settingsOut = process.env.AAB_STUB_SETTINGS_OUT;
if (settingsOut) {
  try {
    const received = JSON.parse(fs.readFileSync(flagVal('--settings'), 'utf8'));
    fs.writeFileSync(settingsOut, JSON.stringify(received), 'utf8');
  } catch {
    /* no --settings or unparsable — nothing to echo */
  }
}

const model = flagVal('--model') ?? 'claude-opus-4-8';
const permissionMode = flagVal('--permission-mode') ?? 'default';
const cwd = process.cwd();

// Fixed canary id so stream and hook merge deterministically.
const TOOL_USE_ID = 'toolu_canary_0001';
const DENY = process.env.AAB_STUB_DENY === '1';
const CANARY_INPUT = DENY ? { command: flagVal('-p') ?? '' } : { command: 'echo aab-canary' };

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// 3a. system/init — reports model, permissionMode (camelCase, as Claude Code does), mcp_servers.
//     AAB_STUB_MCP_SERVERS (JSON array) overrides the reported list, so a test can emulate a
//     fixture MCP server that did or did not connect (evidence-spec §3.1 preconditions).
let mcpServers = [{ name: 'canary-mcp', status: 'connected' }];
if (process.env.AAB_STUB_MCP_SERVERS) {
  try {
    mcpServers = JSON.parse(process.env.AAB_STUB_MCP_SERVERS);
  } catch {
    /* keep the default */
  }
}
emit({
  type: 'system',
  subtype: 'init',
  session_id: 'stub-session',
  cwd,
  model,
  permissionMode,
  mcp_servers: mcpServers,
  tools: ['Bash'],
});

// 4b. ADR-0022 failure modes (AAB_STUB_FAIL), for the newcomer error-path tests. The TEXTS are
//     placeholders, NOT copied from a real claude: no unauthenticated or offline `claude -p` run
//     was made (it is a live launch). They only exercise the plumbing: a result event with
//     is_error:true plus a stderr line and exit 1, which the adapter must surface as warnings.
//       auth    -> result is_error, "Not logged in. Please run /login" (UNVERIFIED wording)
//       network -> stderr "Error: getaddrinfo ENOTFOUND api.anthropic.com" (UNVERIFIED wording)
//       model   -> result is_error, "model: no-such-model does not exist" (UNVERIFIED wording)
const FAIL = process.env.AAB_STUB_FAIL;
if (FAIL === 'auth' || FAIL === 'network' || FAIL === 'model') {
  const text =
    FAIL === 'auth'
      ? 'Not logged in. Please run /login'
      : FAIL === 'model'
        ? `model: ${model} does not exist`
        : 'API Error: Connection error.';
  emit({ type: 'result', subtype: 'success', is_error: true, result: text, total_cost_usd: 0, permission_denials: [] });
  if (FAIL === 'network') process.stderr.write('Error: getaddrinfo ENOTFOUND api.anthropic.com\n');
  process.exit(1);
}

// 5. Hang mode: stop here so the adapter's AbortSignal handler can kill us. Drop a readiness
//    marker first so the test can abort only once init has been emitted (no boot-time race).
if (process.env.AAB_STUB_HANG === '1') {
  const ready = process.env.AAB_STUB_READY;
  if (ready) {
    try {
      fs.writeFileSync(ready, 'ready', 'utf8');
    } catch {
      /* ignore */
    }
  }
  setInterval(() => {}, 1 << 30);
} else {
  // 3b. assistant message carrying one tool_use block. When AAB_STUB_STREAM_ONLY_ID is set,
  //     emit a SECOND tool_use with that id for which NO hook is fired (step 5 below only
  //     fires the hook for TOOL_USE_ID) — exercising a stream-only call that must be retained.
  const content = [
    { type: 'text', text: 'invoking canary' },
    { type: 'tool_use', id: TOOL_USE_ID, name: 'Bash', input: CANARY_INPUT },
  ];
  const streamOnlyId = process.env.AAB_STUB_STREAM_ONLY_ID;
  if (streamOnlyId) {
    content.push({
      type: 'tool_use',
      id: streamOnlyId,
      name: 'Read',
      input: { file_path: '/tmp/aab-stream-only' },
    });
  }
  emit({ type: 'assistant', message: { role: 'assistant', content } });
  // AAB_STUB_SPLIT_UTF8=<text>: one assistant text line written in two pipe writes split inside a
  // multi-byte UTF-8 character, 100 ms apart, so the reader gets two chunks (block B14 ENGINE-03).
  if (process.env.AAB_STUB_SPLIT_UTF8) {
    const bytes = Buffer.from(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: process.env.AAB_STUB_SPLIT_UTF8 }] } }) + '\n', 'utf8');
    let cut = bytes.findIndex((b) => b >= 0xc0); // first lead byte of a multi-byte character
    cut = cut < 0 ? Math.floor(bytes.length / 2) : cut + 1; // inside that character
    process.stdout.write(bytes.subarray(0, cut));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    process.stdout.write(bytes.subarray(cut));
  }

  // 4. Fire every PreToolUse hook with a synthetic payload (real plumbing). Like Claude Code,
  //    hooks from the project's .claude/settings.json and from a `--settings <file>` are
  //    combined; the stub only READS both files and never writes either.
  try {
    const entries = [];
    for (const settingsPath of [path.join(cwd, '.claude', 'settings.json'), flagVal('--settings')]) {
      if (!settingsPath) continue;
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (Array.isArray(settings?.hooks?.PreToolUse)) entries.push(...settings.hooks.PreToolUse);
      } catch {
        /* absent or unparsable — skip */
      }
    }
    const payload = JSON.stringify({
      session_id: 'stub-session',
      transcript_path: path.join(cwd, '.claude', 'transcript.jsonl'),
      cwd,
      permission_mode: permissionMode,
      hook_event_name: 'PreToolUse',
      tool_use_id: TOOL_USE_ID,
      tool_name: 'Bash',
      tool_input: CANARY_INPUT,
    });
    for (const group of entries) {
      const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
      for (const h of hooks) {
        if (h && h.type === 'command' && typeof h.command === 'string') {
          spawnSync(h.command, { shell: true, input: payload });
        }
      }
    }
  } catch {
    /* no hook installed — the stream path alone is still valid */
  }

  // 6. Deny mode: the error tool_result Claude Code emits for a denied tool use.
  if (DENY) {
    emit({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: TOOL_USE_ID,
            is_error: true,
            content: 'Claude requested permissions to use Bash, but you have not granted it yet.',
          },
        ],
      },
    });
  }

  // 3c. result with the client-side cost estimate (+ permission_denials in deny mode).
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    session_id: 'stub-session',
    total_cost_usd: 0.0123,
    ...(DENY
      ? { permission_denials: [{ tool_name: 'Bash', tool_use_id: TOOL_USE_ID, tool_input: CANARY_INPUT }] }
      : {}),
  });
  process.exit(0);
}
