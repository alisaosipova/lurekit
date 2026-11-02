#!/usr/bin/env node
// Offline stub for the Cursor CLI `agent` binary, used only by test/cursor-adapter.test.ts.
// It NEVER touches the network, spends nothing and is deterministic (fixed canary ids, no
// clock/random in the stream). It emits ONLY the event shapes verified in
// docs/design/NOTES-verified-facts.md § Cursor CLI (output-format page):
//   system/init {apiKeySource, cwd, session_id, model, permissionMode}; user {message};
//   assistant {message}; tool_call started/completed {call_id, tool_call, session_id} with
//   readToolCall {args.path, result.success}, writeToolCall {args.path, fileText, toolCallId}
//   and the generic tool_call.function {name, arguments}; result {subtype, is_error,
//   duration_ms, duration_api_ms, result, session_id}.
// Env knobs (all optional):
//   AAB_STUB_ARGV_OUT       file to record argv into
//   AAB_STUB_VERSION_FILE   file holding the --version string (default "2026.10.22-stub")
//   AAB_STUB_VERSION_AFTER  rewrite the version file during the run (simulates auto-update)
//   AAB_STUB_MODEL_NAME     display name for system/init.model (default: echo of --model)
//   AAB_STUB_SPLIT_UTF8=1   also emit a line split mid UTF-8 char across two writes
//   AAB_STUB_UNKNOWN_TOOL=1 also emit a tool_call with an undocumented shape
//   AAB_STUB_FAIL=1         exit 1 with an stderr message and no JSON result
//   AAB_STUB_HANG=1 + AAB_STUB_READY  emit init, write the ready marker, then hang

import fs from 'node:fs';

const argv = process.argv.slice(2);
const versionFile = process.env.AAB_STUB_VERSION_FILE;

if (argv.includes('--version')) {
  let v = '2026.10.22-stub';
  if (versionFile) {
    try { v = fs.readFileSync(versionFile, 'utf8').trim(); } catch { /* default */ }
  }
  process.stdout.write(v + '\n');
  process.exit(0);
}

if (process.env.AAB_STUB_ARGV_OUT) {
  try { fs.writeFileSync(process.env.AAB_STUB_ARGV_OUT, JSON.stringify(argv), 'utf8'); } catch { /* ignore */ }
}

function flagVal(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

if (process.env.AAB_STUB_FAIL === '1') {
  process.stderr.write('Error: stub failure (no JSON emitted on failure)\n');
  process.exit(1);
}

const SESSION = 'stub-cursor-session';
const model = process.env.AAB_STUB_MODEL_NAME ?? flagVal('--model') ?? 'Auto';
// The permissionMode VALUES are placeholders: the field is documented, but how --force/--mode/
// --sandbox map to its value is UNVERIFIED (NOTES). Tests must not rely on these strings.
const permissionMode = argv.includes('--force') ? 'force' : (flagVal('--mode') ?? 'default');
const cwd = flagVal('--workspace') ?? process.cwd();

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

emit({ type: 'system', subtype: 'init', apiKeySource: 'env', cwd, session_id: SESSION, model, permissionMode });

if (process.env.AAB_STUB_HANG === '1') {
  if (process.env.AAB_STUB_READY) {
    try { fs.writeFileSync(process.env.AAB_STUB_READY, 'ready', 'utf8'); } catch { /* ignore */ }
  }
  setInterval(() => {}, 1 << 30);
} else {
  if (versionFile && process.env.AAB_STUB_VERSION_AFTER) {
    fs.writeFileSync(versionFile, process.env.AAB_STUB_VERSION_AFTER, 'utf8');
  }
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: flagVal('-p') ?? '' }] }, session_id: SESSION });
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reading the canary' }] }, session_id: SESSION });

  const readArgs = { path: 'README.md' };
  emit({ type: 'tool_call', subtype: 'started', call_id: 'call_canary_read_0001', tool_call: { readToolCall: { args: readArgs } }, session_id: SESSION });
  emit({ type: 'tool_call', subtype: 'completed', call_id: 'call_canary_read_0001', tool_call: { readToolCall: { args: readArgs, result: { success: { content: 'aab-canary', totalLines: 1 } } } }, session_id: SESSION });

  const writeArgs = { path: 'out.txt', fileText: 'aab-benign', toolCallId: 'call_canary_write_0002' };
  emit({ type: 'tool_call', subtype: 'started', call_id: 'call_canary_write_0002', tool_call: { writeToolCall: { args: writeArgs } }, session_id: SESSION });
  emit({ type: 'tool_call', subtype: 'completed', call_id: 'call_canary_write_0002', tool_call: { writeToolCall: { args: writeArgs, result: { success: { linesCreated: 1 } } } }, session_id: SESSION });

  const fnCall = { function: { name: 'canary_mcp_tool', arguments: '{"q":"aab-canary"}' } };
  emit({ type: 'tool_call', subtype: 'started', call_id: 'call_canary_fn_0003', tool_call: fnCall, session_id: SESSION });
  emit({ type: 'tool_call', subtype: 'completed', call_id: 'call_canary_fn_0003', tool_call: fnCall, session_id: SESSION });

  if (process.env.AAB_STUB_UNKNOWN_TOOL === '1') {
    emit({ type: 'tool_call', subtype: 'started', call_id: 'call_canary_unknown_0004', tool_call: { somethingNew: 42 }, session_id: SESSION });
  }

  if (process.env.AAB_STUB_SPLIT_UTF8 === '1') {
    // One readToolCall line written in two chunks that split a multi-byte UTF-8 char.
    const line = Buffer.from(JSON.stringify({ type: 'tool_call', subtype: 'started', call_id: 'call_canary_utf8_0005', tool_call: { readToolCall: { args: { path: 'caf\u00e9-\u2603.md' } } }, session_id: SESSION }) + '\n', 'utf8');
    const cut = line.indexOf(Buffer.from('\u2603', 'utf8')) + 1;
    fs.writeSync(1, line.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 50));
    fs.writeSync(1, line.subarray(cut));
  }

  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, session_id: SESSION });
  emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1000, duration_api_ms: 900, result: 'done', session_id: SESSION });
  process.exit(0);
}
