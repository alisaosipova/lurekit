# Example setup profiles

These files are copies of the canonical profiles in
[`../../profiles/`](../../profiles/), placed here so the example scripts are
self-contained. The canonical directory is the source of truth; if the two ever
drift, trust `../../profiles/` and its [README](../../profiles/README.md). The one deliberate
difference: the `$comment` in `claude-code-bare.json` spells the section sign as `s4.3` so every
file under `examples/` stays pure ASCII.

- `claude-code-bare.json` - Claude Code with no overrides (the baseline).
- `claude-code-hardened.json` - narrowed setting sources, strict MCP isolation,
  default (manual) permission mode. Hardening only; it loosens nothing.
- `claude-code-netread.json` + `settings/allow-loopback-curl.json` - the one profile that
  loosens something: a permissions allow entry for `curl`, so a headless agent can read the
  loopback content served by the feed and web fixtures (otherwise those scenarios are
  `inconclusive(precondition_failed)`). Pass `--settings` with the settings file on top of the
  bare or hardened flags.

Each file records the `SetupProfile` fields it sets (`profile`) and the
equivalent CLI flags (`cli_flags`). There is no `--profile` flag: pass the flags
shown in `cli_flags` to `lurekit run`, always with `--model` (and ideally
`--agent-version`) on top. See `../run-live.sh` for a worked invocation and
`../../profiles/README.md` for what each knob excludes.
