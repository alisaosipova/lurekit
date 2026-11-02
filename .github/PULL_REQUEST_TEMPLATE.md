<!-- Scenario PRs: see CONTRIBUTING.md. Other PRs: name the ADR/SDD section that authorises the change and
delete the scenario sections below. -->

## Scenario

- File: `scenarios/AAB-NNN.yaml` (exactly one new file)
- Disclosure (`source.primary_url`):
- `fix_status`: patched / partial / unpatched / na  (unpatched: do not use a public PR, see CONTRIBUTING.md)
- Fixture type(s) and detector reused:

## Reproducibility

- [ ] `node dist/cli.js validate` passes
- [ ] `node dist/cli.js plan --model <model-id> --agent <id>` shows the scenario as `KEEP`
- [ ] Ran against at least one agent: live / `--replay` (circle one)
- Agent and version:
- Model:
- Verdict:
- [ ] `manifest.json` from the run kept
- [ ] Any attached evidence was produced with `publish` (no raw transcripts)

## Review rules

- [ ] Cites a public disclosure; no speculative attack
- [ ] Inert: only existing fixtures, loopback/canary hosts, canary values
- [ ] Disclosure-level wording only; no working-exploit, evasion or obfuscation detail
- [ ] Third-party payload text attributed in `notes`
- [ ] Pure ASCII

## Spec (code changes only)

ADR / SDD section:
