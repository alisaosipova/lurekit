#!/usr/bin/env node
// Offline stub for the Codex CLI `codex` binary, used only by test/codex-adapter.test.ts.
// It NEVER touches the network, spends nothing and is deterministic (fixed canary ids, no
// clock/random in the stream). It emits ONLY the `codex exec --json` shapes verified in
// docs/design/NOTES-verified-facts.md § Codex CLI (exec_events.rs, sdk/typescript events/items):
//   thread.started {thread_id}; turn.started {}; item.started/updated/completed {item} with items
//   command_execution {id, command, aggregated_output, exit_code?, status},
//   file_change {id, changes[{path, kind}], status} (completed only),
//   mcp_tool_call {id, server, tool, arguments, result?, status}, web_search {id, query},
//   agent_message {id, text}, reasoning {id, text};
//   turn.completed {usage{input_tokens, cached_input_tokens, cache_write_input_tokens,
//   output_tokens, reasoning_output_tokens}}; turn.failed {error{message}}; error {message}.
// Env knobs (all optional):
//   AAB_STUB_ARGV_OUT       file to record argv into
//   AAB_STUB_ENV_OUT        file to record {CODEX_HOME} into (names the dir only)
//   AAB_STUB_VERSION_FILE   file holding the --version string (default "codex-cli 0.166.0")
//   AAB_STUB_VERSION_AFTER  rewrite the version file during the run (simulates an update)
//   AAB_STUB_SPLIT_UTF8=1   also emit a line split mid UTF-8 char across two writes
//   AAB_STUB_UNKNOWN_ITEM=1 also emit a collab_tool_call item (source-only type)
//   AAB_STUB_TURN_FAILED=1  end with turn.failed + error instead of turn.completed (exit 1)
//   AAB_STUB_FAIL=1         exit 1 with an stderr message and no JSON
//   AAB_STUB_CHECK_HOME=1   mirror the real binary: a CODEX_HOME that does not exist fails
//                           before any JSON (stderr text observed 2026-11-03, 0.166.0), exit 1
//   AAB_STUB_AUTH_FAIL=1    the no-credentials event sequence observed 2026-11-03 (0.166.0):
//                           thread.started, (with -m o3: a model-metadata error item),
//                           turn.started, 4 wss + 5 https "Reconnecting..."
//                           error events around one fallback error item, a final 401 error
//                           event and turn.failed, exit 1 (cf-ray/request ids are placeholders)
//   AAB_STUB_HANG=1 + AAB_STUB_READY  emit thread.started, write the ready marker, then hang
//   AAB_STUB_REPLAY=<file>  print a recorded live `codex exec --json` stream (LV-1, 2026-11-06),
//                           with {{CANARY_PATH}} replaced by the launcher path named in the
//                           planted AGENTS.md of the workdir, then exit 0
//   AAB_STUB_RUN_CANARY=1   with AAB_STUB_REPLAY: also launch that canary (a sandbox that lets the
//                           recorder write); without it the launch is only reported (read-only)

import fs from 'node:fs';

const argv = process.argv.slice(2);
const versionFile = process.env.AAB_STUB_VERSION_FILE;

if (argv.includes('--version')) {
  let v = 'codex-cli 0.166.0';
  if (versionFile) {
    try { v = fs.readFileSync(versionFile, 'utf8').trim(); } catch { /* default */ }
  }
  process.stdout.write(v + '\n');
  process.exit(0);
}

// Mirror the real exec parser for the one known trap: --ask-for-approval/-a is TUI-only and
// `codex exec` rejects it (NOTES § Codex CLI, exec/src/cli.rs vs tui/src/cli.rs).
if (argv.includes('--ask-for-approval') || argv.includes('-a')) {
  process.stderr.write("error: unexpected argument '--ask-for-approval' found\n");
  process.exit(2);
}

if (process.env.AAB_STUB_ARGV_OUT) {
  try { fs.writeFileSync(process.env.AAB_STUB_ARGV_OUT, JSON.stringify(argv), 'utf8'); } catch { /* ignore */ }
}
if (process.env.AAB_STUB_ENV_OUT) {
  try { fs.writeFileSync(process.env.AAB_STUB_ENV_OUT, JSON.stringify({ CODEX_HOME: process.env.CODEX_HOME ?? null }), 'utf8'); } catch { /* ignore */ }
}

if (process.env.AAB_STUB_CHECK_HOME === '1' && process.env.CODEX_HOME !== undefined && !fs.existsSync(process.env.CODEX_HOME)) {
  const msg = `CODEX_HOME points to "${process.env.CODEX_HOME}", but that path does not exist`;
  process.stderr.write(`WARNING: proceeding, even though we could not create PATH aliases: ${msg}\n`);
  process.stderr.write(`Error finding codex home: ${msg}\n`);
  process.exit(1);
}

process.stderr.write('stub-codex: progress goes to stderr\n');

if (process.env.AAB_STUB_AUTH_FAIL === '1') {
  const e401 = (url, extra) => `unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: ${url}, cf-ray: 0000000000000000-XXX${extra}`;
  const wss = 'wss://api.openai.com/v1/responses';
  const https = 'https://api.openai.com/v1/responses';
  const rid = ', request id: req_00000000000000000000000000000000';
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'thread.started', thread_id: 'stub-codex-thread-auth' });
  // Observed with `-m o3` (a model id unknown to the local metadata): one more error item
  // before turn.started.
  const mi = argv.indexOf('-m');
  if (mi >= 0 && argv[mi + 1] === 'o3') {
    out({ type: 'item.completed', item: { id: 'item_m', type: 'error', message: 'Model metadata for `o3` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' } });
  }
  out({ type: 'turn.started' });
  for (let i = 2; i <= 5; i++) out({ type: 'error', message: `Reconnecting... ${i}/5 (${e401(wss, '')})` });
  out({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: `Falling back from WebSockets to HTTPS transport. ${e401(wss, '')}` } });
  for (let i = 1; i <= 5; i++) out({ type: 'error', message: `Reconnecting... ${i}/5 (${e401(https, rid)})` });
  out({ type: 'error', message: e401(https, rid) });
  out({ type: 'turn.failed', error: { message: e401(https, rid) } });
  process.exit(1);
}

if (process.env.AAB_STUB_FAIL === '1') {
  process.stderr.write('Error: stub failure (no JSON emitted)\n');
  process.exit(1);
}

if (process.env.AAB_STUB_REPLAY) {
  let launcher = '';
  try {
    const m = /[^\s`'"]*canary_bin[\\/][^\s`'"]+/.exec(fs.readFileSync('AGENTS.md', 'utf8'));
    launcher = m ? m[0].replace(/[`'"]/g, '') : '';
  } catch { /* no AGENTS.md: placeholder stays empty */ }
  if (process.env.AAB_STUB_RUN_CANARY === '1' && launcher) {
    const { spawnSync } = await import('node:child_process');
    // A .cmd launcher (Windows) needs the command interpreter.
    spawnSync(launcher, [], { stdio: 'ignore', shell: process.platform === 'win32' });
  }
  const text = fs.readFileSync(process.env.AAB_STUB_REPLAY, 'utf8').split('{{CANARY_PATH}}').join(JSON.stringify(launcher).slice(1, -1)); // JSON-escaped (Windows backslashes)
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  process.exit(0);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

emit({ type: 'thread.started', thread_id: 'stub-codex-thread-0001' });

if (process.env.AAB_STUB_HANG === '1') {
  if (process.env.AAB_STUB_READY) {
    try { fs.writeFileSync(process.env.AAB_STUB_READY, 'ready', 'utf8'); } catch { /* ignore */ }
  }
  setInterval(() => {}, 1 << 30);
} else {
  if (versionFile && process.env.AAB_STUB_VERSION_AFTER) {
    fs.writeFileSync(versionFile, process.env.AAB_STUB_VERSION_AFTER, 'utf8');
  }
  emit({ type: 'turn.started' });
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'reading the canary' } });

  const cmd = 'bash -lc ls';
  emit({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: cmd, aggregated_output: '', status: 'in_progress' } });
  emit({ type: 'item.updated', item: { id: 'item_1', type: 'command_execution', command: cmd, aggregated_output: 'README.md\n', status: 'in_progress' } });
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: cmd, aggregated_output: 'README.md\n', exit_code: 0, status: 'completed' } });

  emit({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: 'out.txt', kind: 'add' }], status: 'completed' } });

  const mcp = { id: 'item_3', type: 'mcp_tool_call', server: 'aab-canary', tool: 'canary_mcp_tool', arguments: { q: 'aab-canary' } };
  emit({ type: 'item.started', item: { ...mcp, status: 'in_progress' } });
  emit({ type: 'item.completed', item: { ...mcp, result: { content: [], structured_content: null }, status: 'completed' } });

  emit({ type: 'item.completed', item: { id: 'item_4', type: 'web_search', query: 'aab canary docs' } });

  if (process.env.AAB_STUB_UNKNOWN_ITEM === '1') {
    emit({ type: 'item.started', item: { id: 'item_5', type: 'collab_tool_call', tool: 'spawn', sender_thread_id: 't0', receiver_thread_ids: [], prompt: 'p', agents_states: {}, status: 'in_progress' } });
  }

  if (process.env.AAB_STUB_SPLIT_UTF8 === '1') {
    const line = Buffer.from(JSON.stringify({ type: 'item.started', item: { id: 'item_6', type: 'command_execution', command: 'cat café-☃.md', aggregated_output: '', status: 'in_progress' } }) + '\n', 'utf8');
    const cut = line.indexOf(Buffer.from('☃', 'utf8')) + 1;
    fs.writeSync(1, line.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 50));
    fs.writeSync(1, line.subarray(cut));
  }

  emit({ type: 'item.completed', item: { id: 'item_7', type: 'agent_message', text: 'done' } });
  if (process.env.AAB_STUB_TURN_FAILED === '1') {
    emit({ type: 'turn.failed', error: { message: 'stub turn failure' } });
    emit({ type: 'error', message: 'stub stream error' });
    process.exit(1);
  }
  emit({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 10, cache_write_input_tokens: 5, output_tokens: 20, reasoning_output_tokens: 3 } });
  process.exit(0);
}
