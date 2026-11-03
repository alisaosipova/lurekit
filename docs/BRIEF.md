Project renamed to LureKit on 2026-11-03; AAB remains the scenario-id prefix.

# Brief: agent-attack-bench — research, architecture, and development plan

Author: Alisa (sole developer). Session deliverables, in order; no production code until the first two are approved:

1. `docs/research/landscape.md` — a study of the open sources listed below and what gap remains.
2. `docs/design/architecture.md` — the architecture, with the key decisions written as short ADRs.
3. `docs/plan/roadmap.md` — a 6-week development plan to a public, citable first release.

All three in English, for the global security community. Tight: readable in under 15 minutes each. Prefer tables and numbered decisions over prose. Cite every external claim with a URL. When something is uncertain or unverified, say so explicitly; never fill a gap with a plausible guess.

---

## 1. What we are building

**agent-attack-bench** (working name) is a living, runnable security benchmark for *real agent setups*. It answers one question in one command:

> "How vulnerable is my actual configuration of a coding/computer-use agent — Claude Code, Cursor, Codex CLI, OpenHands, with its MCP servers, skills, hooks and settings — against the catalog of real-world attacks disclosed in 2025–2026?"

Output: a report such as *"vulnerable to 23 of 61 scenarios"*, with every scenario reproducible, every attack linked to its primary source, and the corpus updated weekly as new disclosures appear.

Positioning: the **SSL Labs / AgentDojo for deployed agent setups**. A measurement instrument, not a scanner and not a defense product. Vendors, researchers, and platform teams measure themselves against it. A defensive layer (Phase 2, out of scope for this session) will later be built to pass it.

### Why this and not something else
- Prompt injection is acknowledged as unsolvable at the model layer (OpenAI, UK NCSC). Deterministic controls at the tool boundary are where defenders win, but nobody can currently *measure* whether their controls work.
- Static scanners of MCP servers and skills are crowded and demonstrably bypassable (SkillCloak >90% bypass). Gateways and credential brokers are owned by funded companies (Keycard $38M, Hush, Kong, Traefik). A benchmark is the one artifact in this niche where one person's work compounds through other people's usage, and which platforms cannot absorb.
- Existing asset: `mcp-review-check` (TypeScript, Node ≥20.19, MIT, https://github.com/alisaosipova/mcp-review-check): MCP server linter with a protocol client (stdio, Streamable HTTP, legacy SSE), OAuth probing, fixture servers (good/bad/UI/OAuth), SARIF/JSON/Markdown reporters, CI matrix across three OSes. Reuse what makes sense; do not rewrite what exists.

### Non-goals
- Not a gateway, proxy, credential broker, or runtime firewall.
- Not a static scanner of MCP servers or skills.
- Not a model-level jailbreak benchmark (garak/promptfoo cover that).
- No enterprise features: no SaaS, no dashboards, no multi-tenancy, no auth.
- No speculative attack classes. Every scenario traces to a public disclosure, paper, CVE, or incident report.

---

## 2. Phase A — Research the open sources

Produce `docs/research/landscape.md`. Use web search and fetch primary sources. Do not rely on memory for anything that could have changed.

### 2.1 Existing benchmarks and frameworks (what we are *not* duplicating)
For each record: what it measures, target (model vs agent vs deployed setup), static vs runnable, last update, license, and the precise gap left for us.
- AgentDojo (ETH Zürich) — the closest academic prior.
- CaMeL reference implementation (google-research/camel-prompt-injection) and its AgentDojo results.
- InjecAgent, AgentHarm, τ-bench security variants, any 2026 successors.
- Perplexity BrowseSafe benchmark; OpenAI/Anthropic published red-team methodology for agents, if public.
- OWASP Top 10 for LLM Applications, OWASP MCP Top 10 (2025), OWASP Agentic Security Initiative taxonomies, MITRE ATLAS agent techniques.
- CSA AI Safety Initiative research notes (2026): skill scanner bypass, SKILL.md context poisoning, slopsquatting, NHI governance.

### 2.2 Existing tools that touch our space (potential consumers, not competitors)
For each: what it does, how it could *consume* our benchmark, and whether we can reuse code or fixtures.
- Runtime/behavioral: `mcp-behave`, `panopticon-mcp`, `glassport`, `HOL Guard`, `agentcage`, `agent-sandbox`, `cc-audit`, `agentic-audit-hook`, Anthropic's open-source sandbox runtime.
- Static: `mcp-scan` (snyk/agent-scan), Cisco `mcp-scanner` and `skill-scanner`, `mcp-audit`, `mcpscan-cli`, `@fernforge/mcp-conform`, `mcp-review-check`.
- Data: `JMartynov/mcp-vulnerabilities` (OSV-schema MCP advisory DB), OSV MAL entries for agent-related packages.
- Agent harness docs: Claude Code hooks and settings schema, Cursor rules/hooks, Codex CLI config, OpenHands config — specifically how each can be driven headlessly and how its tool calls can be observed.

### 2.3 Attack catalog seed
Table of **at least 40 candidate scenarios** drawn only from real disclosures, papers, CVEs, or incident reports. Columns: id, short name, attack class (OWASP MCP / Agentic taxonomy), target surface (web page, email/issue, MCP tool description, MCP tool result, SKILL.md, settings/hooks file, package install, image/OCR, URL fragment, diagram render, memory), effect (exfiltration, unauthorized action, persistence, privilege expansion), affected agents, primary source URL, date, **reproducibility assessment** (can an inert fixture trigger it? what would the fixture be?), and status of the original fix (patched / partially / unpatched / N/A).

Known seed items to start from and expand:
1. CometJacking
2. HashJack (URL fragments)
3. Tainted Memories (Atlas)
4. EchoLeak
5. Mermaid-diagram exfiltration (Adam Logue)
6. CVE-2025-59536 (Claude Code RCE via project files)
7. CVE-2026-22708 (Cursor)
8. `.claude/settings.json` hook execution vector used by the August 2026 keyv/ChainDrop worm
9. ClawHavoc / ToxicSkills malicious skills
10. PhantomSkill
11. SkillCloak evasion patterns
12. GuardFall shell-injection bypasses
13. Postmark-MCP exfiltration
14. nx postinstall attack that weaponized AI CLIs
15. Tool poisoning and rug pull (Invariant Labs)
16. Cross-origin escalation between MCP servers
17. DDIPE (document-driven implicit payload execution)
18. Slopsquatting-induced installs
19. Invisible-Unicode instructions in tool descriptions
20. Prompt injection via GitHub issue titles into triage bots (Cline, April 2026)

Flag any item whose primary source could not be verified.

### 2.4 Gap statement
One page: what no existing artifact provides, stated precisely enough that a skeptical reviewer on Hacker News could not refute it by naming an existing tool. If something already does ≥70% of what we plan, **say so first**.

---

## 3. Phase B — Architecture

Produce `docs/design/architecture.md`. Each question as a numbered ADR (context → options → decision → consequences). Where the decision is Alisa's, mark **DECISION NEEDED** with 2–3 options and a recommendation.

### 3.1 Core model
- **Scenario format.** Declarative, reviewable by non-programmers, diffable. Likely YAML with a JSON Schema. Must capture: fixture(s), agent task prompt, setup under test, expected *forbidden effect*, the *benign task* that must still succeed, source citation.
- **Harness runner.** start fixtures → start agent in isolation → feed task → observe → tear down → score. Deterministic in its own behavior.
- **Agent adapters.** One per agent (Claude Code, Cursor, Codex CLI, OpenHands first). Minimal interface: launch headless with config, inject task, collect transcript and tool calls, stop. Document per agent how headless operation and observation work today, with sources.
- **Fixtures.** Reusable inert attack fixtures: malicious web page server, malicious MCP server (stdio and HTTP), malicious skill package, poisoned repository with hooks, fake email/issue feed, poisoned package served from a local registry. All payloads **inert**: touch only canaries, talk only to hosts we control.
- **Effect detectors.** Canary egress host (HTTP/DNS), canary files, canary commands (denylist), canary MCP tool, file-system diff. Observation per layer: agent hooks, MCP proxying, network namespace + egress proxy, syscall tracing — which combination gives attribution per tool call without false negatives.
- **Nondeterminism and scoring.** Runs per scenario (k), definition of "vulnerable", confidence reporting, cost bounds. **Utility check**: pass only if forbidden effect absent *and* benign task completed.
- **Reproducibility.** Pin agent versions, model ids, scenario versions; full transcripts; per-run manifest. Honest reporting of model nondeterminism.
- **Cost control.** Per-run budget caps, smoke mode, full mode, fixture build caching, $/full run estimate per agent.
- **Reporting.** JSON, Markdown, SARIF (optional). Per-scenario evidence; versioned scoring schema.
- **Isolation and safety.** Container or microVM, default-deny egress except canary host and model API. No real credentials. Live payload impossible by construction.

### 3.2 Engineering decisions
- **Language/runtime.** TypeScript vs Python vs Go. **DECISION NEEDED.**
- **Dependency policy.** Minimal runtime deps; pinned, provenance-attested releases (reuse OIDC trusted-publishing workflow from mcp-review-check).
- **Repository layout.** Scenarios as data, fixtures as code, adapters as plugins, detectors as small core. Adding a scenario = one-file PR.
- **Contribution model.** Template, required citation, reproducibility checklist, review rules, CI validating schema and running the scenario against one agent.
- **Weekly update cadence.** Automated vs hand-curated.
- **Ethics / disclosure.** Coordinated disclosure first; scenario published after fix or after 90 days. Licensing note for payload text derived from third-party research.

### 3.3 Threats to validity
Overfitting by vendors, scenario staleness, adapter bugs masking attacks, model drift; mitigation for each.

---

## 4. Phase C — Development plan

Produce `docs/plan/roadmap.md`: 6-week plan to **release 0.1 with a public report**, then Phase 2 outline.

Constraints:
- Development with Claude Fable 5.1 in Claude Code; code volume is not the bottleneck. Alisa's time: ~40% curating/verifying attacks, 30% distribution (writing, discussions, talks), 30% reviewing code. Every week has a curation deliverable and a distribution deliverable.
- Week 2 MVP: harness + Claude Code adapter + 10 scenarios + detectors, all verified manually end-to-end, including a check that detectors cannot false-negative.
- Week 4: 40+ scenarios, Cursor and Codex adapters, GitHub Action, first external pre-reviewer.
- Week 6: run against 5–6 real setups and defensive tools (bare Claude Code; + HOL Guard; + agentcage; + cc-audit; Cursor default; Codex default), publish report + article, open the submission process.
- Explicit "do not build" list per week.
- Risks with triggers and responses.
- Definition of done for 0.1, and kill criterion: if four months after publication nobody else runs it or submits attacks, maintenance mode.

Finish with **a list of open questions for Alisa**, each with a recommended answer.

---

## 5. Working rules

- Research first, then architecture, then plan; each document is shown before the next starts.
- Primary sources over blog posts; vendor marketing is not evidence.
- Quote sparingly; summarize with a link.
- Reuse `mcp-review-check` where it fits; say explicitly what is reused and what is not.
- If research suggests narrowing, merging, or abandoning the project, say so plainly before continuing.
- No application code in this session. Schemas, directory layout, interface sketches are fine.
