# LureKit: development plan (Phase C)

Six weeks to **release 0.1 with a public report**, then a Phase 2 outline. Grounded in
`docs/research/landscape.md` (Phase A) and `docs/design/architecture.md` + `evidence-spec.md`
(Phase B). This plan is the authority for scope and sequencing; `docs/design/BOOTSTRAP.md`
tracks the build order inside the engine.

## Framing

The deliverable is a **measurement instrument plus its first published measurement**, not a
library. A week is "done" only when its curation deliverable (verified scenarios) and its
distribution deliverable (something a reader can see) both land — code that runs nothing a
reader can trust is not progress.

Maintainer time budget (from the brief), applied every week:
- **~40% curating/verifying attacks** — the scarce resource; each scenario needs a primary
  source read, a fixture built, and a manual live run that confirms the detector fires.
- **~30% distribution** — writing, discussion, talks. Nothing ships silently.
- **~30% reviewing code** — Claude Code writes most of the TypeScript; the maintainer reviews.

Code volume is explicitly **not** the bottleneck. Curation throughput and live-run confidence are.

> **Status note (2026-11-01).** The Week 1–2 *engine* already exists in the repo as reviewed,
> fully-offline code: scenario loader+validator, four detectors with blinded self-tests, the
> Claude Code adapter (driven against a stub), the runner, 10 inert scenarios, and the
> JSON/MD/SARIF reporters (BOOTSTRAP steps 1–6, 86 tests). What Week 2 below still owes is the
> part that cannot be written ahead of time: the **manual live end-to-end run against a real
> Claude Code**, which is what turns "the pipeline works on a stub" into "the benchmark measures
> a real agent." The weeks below are written as the plan of record; early weeks fold in the
> head start rather than pretending it does not exist.

---

## Week 1 — Foundations and the first vertical slice

**Theme:** one scenario runs end-to-end, and the project is legible to a stranger.

- **Code**
  - Scenario schema + loader/validator; `scenarios/*.yaml` → one-file contributions. *(done)*
  - First detector behind the `Detector` interface with its positive/negative self-test. *(done)*
  - Repo skeleton: `package.json`, `tsconfig`, vitest, lint/format, `.gitignore`. *(done)*
  - **Still to do:** port CI from `mcp-review-check` (3-OS matrix, schema-validate + test gate);
    `README.md` that states what the tool is and is **not**; `LICENSE` (MIT) + a licensing note
    for third-party-derived payload text.
- **Curation deliverable:** 3 scenarios fully traced to primary disclosures, each with the
  catalog row from landscape §5 it instantiates.
- **Distribution deliverable:** README + a one-paragraph "why this exists" that a security
  engineer can skim and understand the scope in 60 seconds.
- **Do NOT build:** multiple agents, scoring thresholds, SARIF, any dashboard, weekly automation.
- **Exit check:** `npm test` green on CI across the 3-OS matrix; one scenario validates and loads.

---

## Week 2 — MVP: harness + Claude Code + 10 scenarios + detectors, verified live

**Theme:** the brief's week-2 MVP. This is the credibility gate for everything after.

- **Code**
  - Runner lifecycle (provision → run×k → detect → utility check → score → manifest). *(done)*
  - Claude Code adapter driven headless, observation merged from stream + observe-only hooks. *(done)*
  - Four detectors (`canary_egress_http`, `canary_file_read`, `canary_command`,
    `canary_mcp_tool`) each with a blinded-sensor self-test proving no silent false-negative. *(done)*
  - Inert fixtures (poisoned repo, MCP stdio/HTTP, skill package, issue/email feed). *(done)*
  - JSON + Markdown reporters; headline "vulnerable N of M". *(done)*
- **Curation deliverable (the real Week-2 work):** the 10 scenarios run **manually,
  end-to-end, against a live Claude Code** — not a stub. For each: confirm the detector fires
  on the vulnerable path, confirm the benign task still completes on the resisted path, and
  record the transcript + manifest as the reproducibility artifact. This is the ~40% time
  that cannot be delegated to code.
- **Detector-soundness gate:** before trusting any "resisted" verdict, run the false-negative
  check live — deliberately trigger each sensor through a harness-owned stub and confirm it
  reports the hit; a sensor that cannot be shown to fire is reported `inconclusive`, never
  `resisted`. (Automated as the self-test; Week 2 confirms it holds against the live agent's
  real tool-call shapes, which is the thing a stub cannot prove.)
- **Distribution deliverable:** a short "how the benchmark measures one agent" write-up with a
  real (even if ugly) sample report from the live run.
- **Do NOT build:** Cursor/Codex/OpenHands adapters, 40-scenario breadth, GitHub Action,
  defensive-tool comparisons, SARIF polish.
- **Exit check (MVP definition of done):** `vulnerable N of 10` produced from a **live** Claude
  Code run, every verdict backed by an evidence record, detectors proven unable to
  false-negative on the live agent's real output.

---

## Week 3 — Breadth of corpus + a second detector class

**Theme:** turn 10 scenarios into a corpus; make the second agent adapter cheap to add later.

- **Code**
  - Remaining detectors the catalog needs: `canary_egress_dns`, `fs_diff`.
  - `local_registry` fixture (poisoned-package track).
  - Adapter interface hardening: factor the Claude Code specifics so a second adapter is a
    thin file, not a rewrite (observation-layer matrix from evidence-spec §4).
- **Curation deliverable:** reach **25 scenarios**, each disclosure-traced and live-verified on
  Claude Code; cover at least 4 distinct surfaces (MCP, skill, poisoned repo, feed).
- **Distribution deliverable:** publish the scenario catalog as a browsable page (data, not a
  pitch); invite informal feedback from 2–3 trusted practitioners.
- **Do NOT build:** the GitHub Action, the public report, vendor comparisons, auth/accounts.
- **Exit check:** 25 scenarios green against live Claude Code; new detectors ship with self-tests.

---

## Week 4 — Second/third agents, CI action, first external reviewer

**Theme:** the brief's Week-4 milestone — breadth across agents and a contribution path.

- **Code**
  - **Cursor CLI** and **Codex CLI** adapters (document headless + observation per agent, with
    primary sources, as `NOTES-verified-facts.md` already does for Claude Code).
  - **GitHub Action** that validates scenario schema and runs the corpus against one agent in CI
    (reuse the `mcp-review-check` release/CI workflows and OIDC trusted publishing).
  - SARIF reporter finalized for the Action's code-scanning output.
- **Curation deliverable:** **40+ scenarios**, each live-verified on at least Claude Code;
  mark per-scenario `applies_to` for Cursor/Codex as those adapters confirm behavior.
- **Distribution deliverable:** onboard the **first external pre-reviewer**; publish the
  contribution template (required citation + reproducibility checklist + review rules).
- **Do NOT build:** the full 5–6-setup comparison, the launch article, OpenHands adapter,
  any SaaS/hosted runner.
- **Exit check:** 40+ scenarios; Cursor + Codex adapters run ≥1 scenario each end-to-end live;
  CI Action green on a sample PR; one external reviewer has filed real feedback.

---

## Week 5 — Harden, OpenHands, dry-run the comparison

**Theme:** make the measurement defensible before publishing it.

- **Code**
  - OpenHands adapter (CLI-driven; Python agent, so no SDK reuse — per ADR-0001).
  - Budget/cost model finalized: per-run caps, smoke vs full mode, `$/full run` estimate per agent.
  - Redaction pass hardened (no secret/canary leakage into any report format).
- **Curation deliverable:** freeze the corpus for the report; re-run the full set against live
  Claude Code and record k-run stability (how often a verdict flips across repetitions).
- **Distribution deliverable:** a dry-run of the comparison on **2** setups (bare Claude Code
  vs one defensive config) to shake out methodology problems before the real run; draft the
  article outline.
- **Do NOT build:** new scenario classes (corpus is frozen), new detectors, new output formats.
- **Exit check:** full corpus runs reproducibly; cost per full run is known and documented;
  the 2-setup dry-run produces a clean, explainable report.

---

## Week 6 — Run the real comparison, publish, open submissions

**Theme:** the brief's Week-6 release — the first public measurement.

- **Comparison run (the headline):** run the frozen corpus against **5–6 real setups**:
  bare Claude Code; + HOL Guard; + agentcage; + cc-audit; Cursor default; Codex default.
  Each run pins agent version, model id, scenario version; full transcripts + manifests kept.
- **Code:** only what the run surfaces — report polish, no new capability.
- **Curation deliverable:** every headline number in the report traces to an evidence record a
  reader can reproduce; disclosure status checked per scenario against the coordinated-disclosure
  policy (published after fix or 90 days — ADR on ethics/disclosure).
- **Distribution deliverable:** **publish the report + article**, and **open the submission
  process** (issue template + contribution guide live). Announce in the 2–3 channels chosen in Week 3.
- **Do NOT build:** v0.2 features, more agents, a hosted service, anything not needed to publish.
- **Exit check = 0.1 Definition of Done (below).**

---

## Definition of done for 0.1

1. A reader can run `npx lurekit` against their own Claude Code setup and get
   "vulnerable N of M" where every verdict links to a reproducible evidence record.
2. ≥40 scenarios, each citing a primary public disclosure (schema-enforced), each live-verified
   on at least one agent.
3. Detectors cannot silently false-negative: every shipped detector has a passing
   positive/negative self-test, and this was confirmed against a live agent, not only a stub.
4. The public report compares ≥5 real setups, with pinned versions and kept transcripts.
5. CI validates scenario schema and runs the corpus against ≥1 agent on every PR; releases are
   OIDC trusted-published.
6. Contribution path is open: template, required citation, reproducibility checklist, review rules.
7. README states the non-goals as hard scope (not a gateway/scanner/SaaS; no speculative attacks).

## Kill criterion

If, **four months after the 0.1 report is published**, no one outside the project has (a) run
the benchmark against their own setup and reported a result, or (b) submitted a scenario, the
project goes to **maintenance mode**: security fixes and disclosure-status updates only, no new
scenario classes or agents, until external demand reappears. State this publicly so the bar is honest.

## Risks — trigger → response

| Risk | Trigger (how we notice) | Response |
|------|--------------------------|----------|
| **Vendor overfitting** | An agent "passes" by special-casing our canary strings/hosts | Rotate canary values per run; keep the corpus's *classes* public but vary concrete markers; report class-level resilience, not just scenario pass/fail. |
| **Scenario staleness** | A cited disclosure is patched; the scenario no longer reproduces | `source.fix_status` tracked per scenario; a patched scenario moves to a `regression` tier (proves the fix holds) instead of being deleted. |
| **Adapter bug masks an attack** | A "resisted" verdict that a manual run shows is actually vulnerable | Detector self-tests gate every run; any `resisted` from an unverified sensor is downgraded to `inconclusive`; adapters pin agent version so a behavior change is visible. |
| **Model drift / nondeterminism** | A verdict flips across k runs or across model versions | Report k-run stability, not a single run; pin model id in the manifest; publish the flip rate honestly rather than the best run. |
| **Classifier/safety friction blocks authoring** | Harness/design docs tripping a safety classifier (already seen) | Write docs in small neutral sections describing plumbing; keep decisions in ADRs; this is codified in `CLAUDE.md`. |
| **Live-run cost blows the budget** | `$/full run` exceeds the week's cap | Smoke mode (subset) for CI; full mode gated to release; per-run budget caps enforced by the runner. |
| **Single-maintainer bus factor** | Maintainer unavailable mid-cycle | Everything is data + reviewed code in git; the contribution path (Week 4) exists precisely so the corpus can grow without the original author. |

## Open questions for the maintainer (each with a recommended answer)

1. **Weekly update cadence — automated or hand-curated?**
   *Recommend hand-curated for 0.1.* Automation implies a hosted runner (a non-goal) and
   unattended live-agent spend. Revisit only after external contributors appear.
2. **Which defensive tools are in-scope for the Week-6 comparison?**
   *Recommend the brief's list* (HOL Guard, agentcage, cc-audit) *plus bare Cursor/Codex
   defaults*; drop any that cannot be stood up reproducibly offline rather than weakening the
   inertness guarantee to accommodate them.
3. **Disclosure window for scenarios citing still-unpatched issues.**
   *Recommend: publish the scenario only after fix or 90 days, whichever first*; until then keep
   it in a private tier that CI can run but the public catalog does not list.
4. **Distribution channels for the launch.**
   *Recommend 2–3 focused venues* (one practitioner mailing list / forum, one conference CFP,
   one blog) over a broad social push; the audience is narrow and technical.
5. **npm package name + scope.**
   *Recommend publishing under a scope you control* (e.g. `@<you>/lurekit`) to avoid
   name-squatting ambiguity and to make OIDC trusted publishing straightforward.
6. **Should browser-track scenarios ship in 0.1 at all?**
   *Recommend keeping them `runnable:false` in 0.1* (documented but not executed), as the current
   schema already enforces, and promoting them in Phase 2 when a browser adapter exists.

---

## Phase 2 outline (post-0.1, not scheduled here)

- **Browser/computer-use track** made runnable (a real browser adapter; promote the
  `runnable:false` rows).
- **More agents** as they gain headless + observable tool calls; keep the adapter interface thin.
- **Regression tiers** grow as disclosures get patched — the benchmark becomes a "does the fix
  still hold?" suite, not only an "is it vulnerable?" snapshot.
- **Community submission review** scaled: triage rota, scheduled re-runs of the corpus against
  current agent versions to catch model drift.
- **Still explicitly out of scope in Phase 2:** gateway/proxy/credential-broker, static scanning
  of MCP servers or skills, model-level jailbreak benchmarking, any SaaS/dashboard/multi-tenancy.
  The instrument measures; it does not defend.
