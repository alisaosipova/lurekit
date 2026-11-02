// Fixture registry + a FixtureProvider for the runner (ADR-0002). Maps a scenario's
// `fixtures[].type` (FixtureKind) to the concrete inert fixture that stands that surface up, and
// hands the ref's `params` to its constructor (ADR-0002 "Interface notes - fixture params"); a
// parameterised fixture validates them strictly and throws FixtureParamsError on an unknown key
// or value. Fixtures are built
// lazily per scenario; an unimplemented kind throws a clear error.

import type { Fixture } from './fixture.js';
import type { FixtureKind, FixtureRef, Scenario } from '../scenario/types.js';
import { PoisonedRepoFixture } from './poisonedRepo.js';
import { McpStdioFixture, McpHttpFixture } from './mcpServerFixture.js';
import { SkillPackageFixture } from './skillPackage.js';
import { IssueFeedFixture, EmailFeedFixture } from './contentFeed.js';
import { WebServerFixture } from './webServer.js';
import { LocalRegistryFixture } from './localRegistry.js';
export { FixtureBase, FixtureCanaryError } from './fixture.js';
export { FixtureParamsError } from './params.js';
export { PoisonedRepoFixture } from './poisonedRepo.js';
export { McpStdioFixture, McpHttpFixture } from './mcpServerFixture.js';
export { SkillPackageFixture } from './skillPackage.js';
export { IssueFeedFixture, EmailFeedFixture } from './contentFeed.js';
export { WebServerFixture } from './webServer.js';
export { LocalRegistryFixture } from './localRegistry.js';

/** Fixture factories keyed by FixtureKind. A kind present here is buildable in 0.1. Every
 *  FixtureKind in the schema enum now has a concrete inert fixture (ADR-0002). */
const registry: Partial<Record<FixtureKind, (params: unknown) => Fixture>> = {
  poisoned_repo: (p) => new PoisonedRepoFixture(p),
  mcp_stdio: (p) => new McpStdioFixture(p),
  mcp_http: (p) => new McpHttpFixture(p),
  skill_package: (p) => new SkillPackageFixture(p),
  // These kinds are owned by other fixture modules; params are passed through unchanged and
  // validated (or ignored) by those constructors.
  issue_feed: (p) => construct(IssueFeedFixture, p),
  email_feed: (p) => construct(EmailFeedFixture, p),
  web_server: (p) => construct(WebServerFixture, p),
  local_registry: (p) => construct(LocalRegistryFixture, p),
};

/** `new Ctor(params)` for a fixture class whose constructor may or may not declare params. */
function construct(ctor: abstract new (...args: never[]) => Fixture, params: unknown): Fixture {
  return new (ctor as unknown as new (params?: unknown) => Fixture)(params);
}

/** Kinds with a concrete inert fixture in this build. */
export const IMPLEMENTED_FIXTURES = Object.keys(registry) as FixtureKind[];

/** Construct the fixture for one FixtureRef, passing `ref.params` to it. Throws for a kind not
 *  implemented in 0.1 and (FixtureParamsError) for params the fixture does not accept. */
export function buildFixture(ref: FixtureRef): Fixture {
  const make = registry[ref.type];
  if (!make) {
    throw new Error(
      `fixture "${ref.type}" is not implemented in 0.1 (implemented: ${IMPLEMENTED_FIXTURES.join(', ')})`,
    );
  }
  return make(ref.params);
}

/** A FixtureProvider for the runner: build every fixture a scenario declares. */
export function fixturesForScenario(scenario: Scenario): Fixture[] {
  return (scenario.fixtures ?? []).map(buildFixture);
}
