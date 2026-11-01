// Fixture contract (ADR-0002, "Fixture contract"). A Fixture is provisioned into a run and
// torn down after it; it is the attack surface a scenario stands up (a poisoned repo, a
// loopback MCP/web server, a skill package). Fixtures are INERT BY CONSTRUCTION: the base
// class — never a per-scenario check — enforces three invariants so an author cannot build a
// live-payload fixture by accident (CLAUDE.md; ADR-0002):
//
//   (a) Loopback only. Any endpoint a fixture exposes or names must resolve to
//       127.0.0.1 / localhost / ::1, or to the harness-provided canary host. assertLoopback().
//   (b) No real secret. A fixture carries only canary values — a random marker, a loopback
//       URL, a no-op command. A value that looks like a live credential is rejected.
//       assertNoRealSecret().
//   (c) A fixture never calls a canary itself. If a fixture originated traffic to the canary
//       the detector's negative control (evidence-spec §1.4) would see fixture-made traffic
//       and misreport it. Any outbound target a fixture contacts must pass assertNotCanary().
//
// This module exports ONLY the interface, the FixtureBase abstract class, and the three
// assert helpers. Concrete fixtures (poisoned repo, loopback MCP server, ...) land in step 5;
// the trivial in-memory noop fixture used to exercise the runner lives under test/ as a test
// helper (it reuses a real FixtureKind value and does nothing — the schema enum is unchanged).

import type { SetupProfile } from '../adapters/adapter.js';
import type { FixtureKind } from '../scenario/types.js';

/** Context handed to a fixture at provision time. `runDir` is the per-run evidence directory
 *  (shared with the detectors); `workdir` is the agent's provisioned working directory;
 *  `canaryHost` is an optional harness-controlled host a fixture may legitimately bind/point
 *  at in addition to loopback. */
export interface FixtureContext {
  runDir: string;
  workdir: string;
  canaryHost?: string;
}

/** What a fixture returns once provisioned: the canary identifiers it stood up, and an
 *  optional profile fragment the agent needs to reach it (e.g. an `.mcp.json` entry pointing
 *  at a loopback server). The runner merges `profilePatch` into the profile under test WITHOUT
 *  loosening it (ADR-0002 runner lifecycle step 2). */
export interface FixtureProvision {
  canaries: Record<string, string>;
  profilePatch?: Partial<SetupProfile>;
}

export interface Fixture {
  readonly type: FixtureKind;
  provision(ctx: FixtureContext): Promise<FixtureProvision>;
  teardown(): Promise<void>;
}

/** Thrown when a fixture violates an inertness invariant. The message never echoes the
 *  offending value when it looks like a secret (CLAUDE.md: never print credentials). */
export class FixtureInertnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureInertnessError';
  }
}

// --- Invariant (a): loopback only -------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Extract the bare host from a host, host:port, or URL. IPv6 may be bracketed
 *  (`[::1]:8080`) or bare (`::1`). Returns lowercase. */
function extractHost(hostOrUrl: string): string {
  let s = hostOrUrl.trim();
  const scheme = s.indexOf('://');
  if (scheme >= 0) s = s.slice(scheme + 3);
  const at = s.indexOf('@'); // strip userinfo
  if (at >= 0) s = s.slice(at + 1);
  s = s.split('/')[0].split('?')[0].split('#')[0]; // strip path/query/fragment
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end >= 0) return s.slice(1, end).toLowerCase(); // bracketed IPv6
  }
  // A single colon is host:port; multiple colons with no brackets is a bare IPv6 literal.
  if ((s.match(/:/g) ?? []).length === 1) s = s.slice(0, s.indexOf(':'));
  return s.toLowerCase();
}

/** Invariant (a). Reject any endpoint that is not loopback or the provided canary host.
 *  Accepts a bare host, host:port, or full URL. */
export function assertLoopback(hostOrUrl: string, canaryHost?: string): void {
  const host = extractHost(hostOrUrl);
  const allowed = new Set(LOOPBACK_HOSTS);
  if (canaryHost) allowed.add(extractHost(canaryHost));
  if (!allowed.has(host)) {
    throw new FixtureInertnessError(
      `fixture endpoint "${hostOrUrl}" is not loopback or the canary host ` +
        `(allowed: ${[...allowed].join(', ')})`,
    );
  }
}

// --- Invariant (b): no real secret ------------------------------------------------------

// Known live-credential shapes (prefix + plausible body length). These catch a real token
// pasted into a fixture by mistake; they deliberately do NOT flag a bare random hex/base64
// marker (a legitimate canary value has no such prefix), so the control detectors' random
// tokens/markers pass. Matching is by prefix family, per the step-4 brief.
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'OpenAI/Anthropic-style key (sk-)', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'GitHub token (ghp_/gho_/ghu_/ghs_/ghr_)', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitHub fine-grained PAT (github_pat_)', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'AWS access key id (AKIA)', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token (xox*)', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API key (AIza)', re: /\bAIza[0-9A-Za-z_-]{35,}\b/ },
];

/** Invariant (b). Reject a value that matches a known live-credential shape. The error names
 *  the pattern family but never echoes the matched value (CLAUDE.md). */
export function assertNoRealSecret(value: string): void {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(value)) {
      throw new FixtureInertnessError(
        `fixture value matches a live-credential shape (${name}); fixtures carry canaries only ` +
          `(value redacted)`,
      );
    }
  }
}

/** Whether a value is just a bare loopback host (optionally host:port, no path). Such a value
 *  is a legitimate bind target, not a specific canary, so assertNotCanary does not track it. */
function isBareLoopback(value: string): boolean {
  if (value.includes('/')) return false;
  return LOOPBACK_HOSTS.has(extractHost(value));
}

/** Whether a canary entry names a network endpoint that invariant (a) should check. A value
 *  with a scheme (`://`) always counts; otherwise only keys that read as an endpoint do, so a
 *  file path / marker / command is not mistaken for a host. */
function looksLikeEndpoint(key: string, value: string): boolean {
  if (value.includes('://')) return true;
  return /(?:^|_)(host|url|uri|endpoint|addr|origin)$/i.test(key);
}

/** Recursively apply assertNoRealSecret to every string in an object (used on profilePatch,
 *  which may carry settings/env the fixture wants copied into the run). */
function scanForSecrets(value: unknown): void {
  if (typeof value === 'string') {
    assertNoRealSecret(value);
  } else if (Array.isArray(value)) {
    for (const v of value) scanForSecrets(v);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) scanForSecrets(v);
  }
}

// --- FixtureBase ------------------------------------------------------------------------

/** Base class that enforces the inertness invariants in one place (ADR-0002). A concrete
 *  fixture implements `provisionInert()` and `teardown()`; the base's `provision()` validates
 *  the returned canaries/profilePatch before handing them back, so inertness cannot be
 *  bypassed by forgetting a per-scenario check. */
export abstract class FixtureBase implements Fixture {
  abstract readonly type: FixtureKind;

  /** The canary host the harness permits in addition to loopback, captured at provision. */
  protected canaryHost?: string;

  /** The canary values this fixture stood up — used by assertNotCanary() so the fixture
   *  cannot call its own decoy (invariant c). */
  private readonly ownCanaries = new Set<string>();

  /** Subclasses implement inert provisioning here. */
  protected abstract provisionInert(ctx: FixtureContext): Promise<FixtureProvision>;

  abstract teardown(): Promise<void>;

  async provision(ctx: FixtureContext): Promise<FixtureProvision> {
    this.canaryHost = ctx.canaryHost;
    const result = await this.provisionInert(ctx);
    this.validateInertness(result);
    // Track specific canary identifiers (tokens, markers, decoy URLs) so assertNotCanary can
    // catch a self-call. A bare loopback host (127.0.0.1/localhost/::1) is NOT a specific
    // canary — a fixture legitimately serves on loopback — so it is not tracked.
    for (const v of Object.values(result.canaries)) {
      if (typeof v === 'string' && v.length > 0 && !isBareLoopback(v)) this.ownCanaries.add(v);
    }
    return result;
  }

  /** Invariant (a), for subclass use when binding/naming an endpoint. */
  protected assertLoopback(hostOrUrl: string): void {
    assertLoopback(hostOrUrl, this.canaryHost);
  }

  /** Invariant (b), for subclass use before embedding a value. */
  protected assertNoRealSecret(value: string): void {
    assertNoRealSecret(value);
  }

  /** Invariant (c). A fixture MUST route any outbound target it is about to contact through
   *  this guard; it throws if the target is one of the fixture's own canaries or the harness
   *  canary host, keeping the detectors' negative control clean (evidence-spec §1.4). The
   *  0.1 fixtures originate no traffic, so this is a protective hook for future fixtures. */
  protected assertNotCanary(target: string): void {
    for (const canary of this.ownCanaries) {
      if (target.includes(canary)) {
        throw new FixtureInertnessError(
          `fixture "${this.type}" attempted to call its own canary — fixtures must never ` +
            `originate traffic to a canary (evidence-spec §1.4)`,
        );
      }
    }
    if (this.canaryHost && target.includes(this.canaryHost)) {
      throw new FixtureInertnessError(
        `fixture "${this.type}" attempted to call the canary host — fixtures must never ` +
          `originate traffic to the canary host (evidence-spec §1.4)`,
      );
    }
  }

  private validateInertness(result: FixtureProvision): void {
    for (const [key, value] of Object.entries(result.canaries)) {
      if (typeof value !== 'string') continue;
      assertNoRealSecret(value);
      if (looksLikeEndpoint(key, value)) assertLoopback(value, this.canaryHost);
    }
    if (result.profilePatch) scanForSecrets(result.profilePatch);
  }
}
