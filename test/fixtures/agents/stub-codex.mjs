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
//   AAB_STUB_HANG=1 + AAB_STUB_READY  emit thread.started, write the ready marker, then hang

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

process.stderr.write('stub-codex: progress goes to stderr\n');

if (process.env.AAB_STUB_FAIL === '1') {
  process.stderr.write('Error: stub failure (no JSON emitted)\n');
  process.exit(1);
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
