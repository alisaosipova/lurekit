# claude-sample recording (ADR-0015)

An inert, hand-sanitised recording in the shape of `claude -p --output-format stream-json --verbose`
plus the observation hook's log. Fields the parser reads follow `docs/design/NOTES-verified-facts.md`
(`system/init` model and `mcp_servers`, `result.total_cost_usd`, hook `session_id` /
`transcript_path` / `cwd` / `permission_mode` / `hook_event_name` / `tool_use_id`, PostToolUse
`duration_ms`) and the shapes the live adapter parses (`permissionMode`, assistant `tool_use`
blocks, hook `tool_name` / `tool_input`). Other fields (`apiKeySource`, `output_style`,
`claude_code_version`, `tools`, `usage`, `tool_response`) are illustrative and UNVERIFIED; the
parser ignores them. One benign
`Read` of a notes file shares `tool_use_id` `toolu_rec_0001` between the stream and both hook entries.
No secrets, no network hosts; paths are placeholders under `/workspace`.
