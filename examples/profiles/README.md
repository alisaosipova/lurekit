# Example setup profiles: moved

The setup profiles live in one place: [`../../profiles/`](../../profiles/). This directory used to
hold copies of them; the copies drifted, so they were removed (ADR-0011, one profiles directory).

- `profiles/claude-code-bare.json` - Claude Code with no overrides (the baseline).
- `profiles/claude-code-hardened.json` - narrowed setting sources, strict MCP isolation, default
  (manual) permission mode. Hardening only.
- `profiles/claude-code-netread.json` + `profiles/settings/allow-loopback-curl.json` - the one
  profile that loosens something (a permissions allow entry for `curl` on loopback).

There is no `--profile` flag: pass the flags in each file's `cli_flags` to `lurekit run`. See
[`../run-live.sh`](../run-live.sh) for a worked invocation and
[`../../profiles/README.md`](../../profiles/README.md) for what each knob excludes.
