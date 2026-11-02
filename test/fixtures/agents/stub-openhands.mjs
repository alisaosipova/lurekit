#!/usr/bin/env node
// Offline stub for the legacy OpenHands CLI `openhands` binary, used only by
// test/openhands-adapter.test.ts. It NEVER touches the network, spends nothing and is
// deterministic (fixed ids and timestamps). It emits ONLY the shapes verified in
// docs/design/NOTES-verified-facts.md § OpenHands (CLI 283c6ac3, SDK v1.28.1):
//   stdout = Rich text lines interleaved with `--json` JSONL SDK events tagged by `kind`
//   (every event has id, timestamp, source): ActionEvent {tool_name, tool_call_id, tool_call,
//   action{kind}, thought, reasoning_content, llm_response_id, security_risk, summary},
//   ObservationEvent {tool_name, tool_call_id, action_id, observation{kind}}, AgentErrorEvent
//   {error, tool_call_id}; actions TerminalAction / FileEditorAction / MCPToolAction{data};
//   TerminalObservation {command, exit_code, timeout, metadata}.
//   Persisted log: $OPENHANDS_CONVERSATIONS_DIR/<id-hex>/base_state.json + events/event-NNNNN-<id>.json.
//   `--version` -> "OpenHands CLI <version>". Missing task with --headless -> argparse exit 2.
//   --override-with-envs with no settings file and missing LLM_API_KEY/LLM_MODEL -> exit 1.
// The `tool_name` values ("terminal", "file_editor", "canary_mcp_tool") are PLACEHOLDERS: how the
// real CLI forms tool_name is UNVERIFIED and the adapter does not depend on the values.
// Env knobs (all optional):
//   AAB_STUB_ARGV_OUT       file to record argv into
//   AAB_STUB_ENV_OUT        file to record env facts into (dir names, model, base URL, key PRESENCE only)
//   AAB_STUB_VERSION_FILE   file holding the --version string (default "OpenHands CLI 1.16.0")
//   AAB_STUB_VERSION_AFTER  rewrite the version file during the run (simulates an update)
//   AAB_STUB_MODEL_ECHO     model printed on the "Agent initialized" line (default $LLM_MODEL)
//   AAB_STUB_NO_ECHO=1      print no model line and write no agent.llm.model to base_state
//   AAB_STUB_NO_ACTIONS=1   emit no ActionEvent (a weak model answering like a chatbot)
//   AAB_STUB_UNKNOWN_KIND=1 also emit an event of an uninterpreted kind
//   AAB_STUB_AGENT_ERROR=1  also emit an AgentErrorEvent
//   AAB_STUB_COST           accumulated_cost written to base_state (default 0)
//   AAB_STUB_TRANSCRIPT_EXTRA=1  persist one extra ActionEvent that is not streamed
//   AAB_STUB_HANG=1 + AAB_STUB_READY  write the ready marker, then hang
//   AAB_STUB_NO_CONV_ID=1  print no "Conversation ID:" line

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const env = process.env;
const versionFile = env.AAB_STUB_VERSION_FILE;

if (argv.includes('--version') || argv.includes('-v')) {
  let v = 'OpenHands CLI 1.16.0';
  if (versionFile) {
    try { v = fs.readFileSync(versionFile, 'utf8').trim(); } catch { /* default */ }
  }
  process.stdout.write(v + '\n');
  process.exit(0);
}

if (env.AAB_STUB_ARGV_OUT) {
  try { fs.writeFileSync(env.AAB_STUB_ARGV_OUT, JSON.stringify(argv), 'utf8'); } catch { /* ignore */ }
}
if (env.AAB_STUB_ENV_OUT) {
  const rec = {
    cwd: process.cwd(),
    HOME: env.HOME ?? null,
    OPENHANDS_PERSISTENCE_DIR: env.OPENHANDS_PERSISTENCE_DIR ?? null,
    OPENHANDS_CONVERSATIONS_DIR: env.OPENHANDS_CONVERSATIONS_DIR ?? null,
    OPENHANDS_WORK_DIR: env.OPENHANDS_WORK_DIR ?? null,
    LLM_MODEL: env.LLM_MODEL ?? null,
    LLM_BASE_URL: env.LLM_BASE_URL ?? null,
    LLM_API_KEY_set: typeof env.LLM_API_KEY === 'string' && env.LLM_API_KEY.length > 0,
  };
  try { fs.writeFileSync(env.AAB_STUB_ENV_OUT, JSON.stringify(rec), 'utf8'); } catch { /* ignore */ }
}

const headless = argv.includes('--headless');
const ti = argv.indexOf('-t');
const task = ti >= 0 ? argv[ti + 1] : undefined;
if (headless && task === undefined && !argv.includes('-f')) {
  process.stderr.write('openhands: error: --headless requires either --task or --file to be specified\n');
  process.exit(2);
}

const persistence = env.OPENHANDS_PERSISTENCE_DIR ?? path.join(env.HOME ?? '.', '.openhands');
const conversations = env.OPENHANDS_CONVERSATIONS_DIR ?? path.join(persistence, 'conversations');
const hasSettings = fs.existsSync(path.join(persistence, 'agent_settings.json'));
if (argv.includes('--override-with-envs') && !hasSettings) {
  const missing = ['LLM_API_KEY', 'LLM_MODEL'].filter((k) => !env[k]);
  if (missing.length > 0) {
    process.stderr.write(`Missing required environment variable(s): ${missing.join(', ')}\n`);
    process.exit(1);
  }
}

const say = (s) => process.stdout.write(s + '\n');
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const model = env.AAB_STUB_MODEL_ECHO ?? env.LLM_MODEL;
say('Initializing agent...');
if (env.AAB_STUB_NO_ECHO !== '1') say(`✓ Agent initialized with model: ${model}`);

if (env.AAB_STUB_HANG === '1') {
  if (env.AAB_STUB_READY) {
    try { fs.writeFileSync(env.AAB_STUB_READY, 'ready', 'utf8'); } catch { /* ignore */ }
  }
  setInterval(() => {}, 1 << 30);
} else {
  if (versionFile && env.AAB_STUB_VERSION_AFTER) fs.writeFileSync(versionFile, env.AAB_STUB_VERSION_AFTER, 'utf8');

  const convId = '0123456789abcdef0123456789abcdef';
  const ts = '2026-11-02T00:00:00.000000';
  let n = 0;
  const events = [];
  const ev = (o) => { const e = { id: `ev-${String(n++).padStart(4, '0')}`, timestamp: ts, ...o }; events.push(e); return e; };
  const action = (toolName, callId, act) => ev({
    kind: 'ActionEvent', source: 'agent', tool_name: toolName, tool_call_id: callId,
    tool_call: { id: callId, type: 'function', function: { name: toolName, arguments: JSON.stringify(act) } },
    action: act, thought: [], reasoning_content: null, llm_response_id: 'resp-0001', security_risk: 'UNKNOWN', summary: null,
  });
  const observation = (toolName, callId, actionId, obs) => ev({
    kind: 'ObservationEvent', source: 'environment', tool_name: toolName, tool_call_id: callId, action_id: actionId, observation: obs,
  });

  ev({ kind: 'MessageEvent', source: 'user', llm_message: { role: 'user', content: [{ type: 'text', text: task ?? '' }] } });
  if (env.AAB_STUB_NO_ACTIONS !== '1') {
    const a1 = action('terminal', 'call_1', { kind: 'TerminalAction', command: 'ls', is_input: false, timeout: null, reset: false });
    observation('terminal', 'call_1', a1.id, { kind: 'TerminalObservation', command: 'ls', exit_code: 0, timeout: false, metadata: {} });
    const a2 = action('file_editor', 'call_2', {
      kind: 'FileEditorAction', command: 'create', path: path.join(env.OPENHANDS_WORK_DIR ?? process.cwd(), 'out.txt'),
      file_text: 'summary: café ☃\n', old_str: null, new_str: null, insert_line: null, view_range: null,
    });
    observation('file_editor', 'call_2', a2.id, { kind: 'FileEditorObservation', command: 'create' });
    const a3 = action('canary_mcp_tool', 'call_3', { kind: 'MCPToolAction', data: { q: 'aab-canary' } });
    observation('canary_mcp_tool', 'call_3', a3.id, { kind: 'MCPToolObservation', tool_name: 'canary_mcp_tool' });
  }
  if (env.AAB_STUB_AGENT_ERROR === '1') ev({ kind: 'AgentErrorEvent', source: 'agent', tool_name: 'terminal', tool_call_id: 'call_9', error: 'stub agent error' });
  if (env.AAB_STUB_UNKNOWN_KIND === '1') ev({ kind: 'FutureEvent', source: 'environment', payload: 1 });
  ev({ kind: 'MessageEvent', source: 'agent', llm_message: { role: 'assistant', content: [{ type: 'text', text: 'summary: done' }] } });

  for (const e of events) emit(e);

  const persisted = [...events];
  if (env.AAB_STUB_TRANSCRIPT_EXTRA === '1') {
    persisted.push({ id: 'ev-extra', timestamp: ts, kind: 'ActionEvent', source: 'agent', tool_name: 'terminal', tool_call_id: 'call_hidden', action: { kind: 'TerminalAction', command: 'true' } });
  }
  const convDir = path.join(conversations, convId);
  fs.mkdirSync(path.join(convDir, 'events'), { recursive: true });
  persisted.forEach((e, i) => {
    fs.writeFileSync(path.join(convDir, 'events', `event-${String(i).padStart(5, '0')}-${e.id}.json`), JSON.stringify(e, null, 2), 'utf8');
  });
  const llm = env.AAB_STUB_NO_ECHO === '1' ? { api_key: '**********' } : { model, api_key: '**********' };
  const cost = Number(env.AAB_STUB_COST ?? '0');
  fs.writeFileSync(path.join(convDir, 'base_state.json'), JSON.stringify({
    id: convId, agent: { kind: 'Agent', llm }, execution_status: 'finished',
    stats: { usage_to_metrics: { agent: { accumulated_cost: cost, accumulated_token_usage: { prompt_tokens: 100, completion_tokens: 20 } } } },
  }, null, 2), 'utf8');

  say('CONVERSATION SUMMARY');
  say('Goodbye!');
  if (env.AAB_STUB_NO_CONV_ID !== '1') say(`Conversation ID: ${convId}`);
  say(`Hint: run openhands --resume ${convId} to continue`);
  process.exit(0);
}
