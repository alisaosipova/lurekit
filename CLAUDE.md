# LureKit — project guide

A runnable, disclosure-traced security benchmark for deployed coding-agent configurations.
Read `docs/BRIEF.md` for the full charter and `docs/research/landscape.md` for the research.

## Default workflow: SDD (spec-driven development)

**The spec drives the code. No production code lands without a design that covers it.**
This is the default for every change, not only for the initial build.

1. **Spec first.** Before implementing a component, there must be an approved design for it:
   an ADR under `docs/design/adr-*.md`, a section of `docs/design/architecture.md` (the SDD),
   or `docs/design/evidence-spec.md`. If the design is missing, write it first and get it
   approved, then implement. `docs/design/BOOTSTRAP.md` tracks what is specced vs pending.
2. **Phase order holds.** Research → design (SDD) → plan → code. Phases A (research), B
   (SDD + evidence spec) and C (roadmap) are all written. When a new decision arises, add an
   ADR to architecture.md; keep the design current. Do not treat the design as optional.
3. **Write design docs in small, incremental steps.** One ADR or one section per step.
   Large single-shot harness write-ups have been blocked by a safety classifier; small
   neutral sections describing plumbing (schemas, interfaces, control sensors) go through.
4. **Each code change cites its spec.** A PR/commit that adds behaviour names the ADR or
   SDD section that authorises it. If none exists, the change is out of order — spec it.
5. **Keep the SDD current.** When a decision changes during implementation, update the ADR
   in the same change; the design must not drift from the code.

### Where the design lives
- `docs/design/architecture.md` - the SDD (ADR index + ADR-0003..0020). **Written** (ADR-0013 cadence is DECISION NEEDED).
- `docs/design/evidence-spec.md` — evidence/detector contract (§1–§6). **Written.**
- `docs/design/adr-*.md` — standalone decisions (ADR-0001: TypeScript/Node, accepted).
- `docs/design/NOTES-verified-facts.md` — verified primary-source facts feeding the ADRs.
- `docs/design/BOOTSTRAP.md` — build order and what is specced vs pending.

## Non-goals (hard constraints from the brief)
Not a gateway/proxy/credential broker/runtime firewall; not a static scanner of MCP servers
or skills; not a model-level jailbreak bench; no SaaS/dashboards/multi-tenancy/auth; no
speculative attacks — every scenario cites a public disclosure (enforced by the scenario
schema's required `source.primary_url`). If a change drifts toward any of these, stop and flag it.

## Conventions
- TypeScript, Node >=20.19, ESM. Mirror `mcp-review-check` toolchain (ajv, yaml, zod, vitest,
  tsc, SHA-pinned actions, OIDC trusted-publishing release, 3-OS CI).
- Reuse from `../mcp-review-check`: protocol client, fixture servers, JSON/MD/SARIF reporters,
  CI/release workflows. Do not reuse its static review rules or OAuth DCR probing (non-goals).
- Fixtures are inert by construction: a base class binds only to loopback / a canary host and
  uses only canary values. Enforce in the base class, never per scenario.
- Detectors are control sensors outside the agent; each ships positive + negative control runs
  that prove it cannot silently miss its own signal. Describe them as controls, not evasions.

## Docs language
Docs and code comments in English. Chat with the maintainer in Russian.
