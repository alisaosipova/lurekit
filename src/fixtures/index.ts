// Fixture registry + a FixtureProvider for the runner (ADR-0002). Maps a scenario's
// `fixtures[].type` (FixtureKind) to the concrete inert fixture that stands that surface up.
// Fixtures are built lazily per scenario; an unimplemented kind throws a clear error.

import type { Fixture } from './fixture.js';
import type { FixtureKind, FixtureRef, Scenario } from '../scenario/types.js';
import { PoisonedRepoFixture } from './poisonedRepo.js';
import { McpStdioFixture, McpHttpFixture } from './mcpServerFixture.js';
import { SkillPackageFixture } from './skillPackage.js';
import { IssueFeedFixture, EmailFeedFixture } from './contentFeed.js';

export { FixtureBase } from './fixture.js';
export { PoisonedRepoFixture } from './poisonedRepo.js';
export { McpStdioFixture, McpHttpFixture } from './mcpServerFixture.js';
export { SkillPackageFixture } from './skillPackage.js';
export { IssueFeedFixture, EmailFeedFixture } from './contentFeed.js';

/** Fixture factories keyed by FixtureKind. A kind present here is buildable in 0.1. 'web_server'
 *  (a test helper) and 'local_registry' (deferred — see step-5 report) are intentionally absent. */
const registry: Partial<Record<FixtureKind, () => Fixture>> = {
  poisoned_repo: () => new PoisonedRepoFixture(),
  mcp_stdio: () => new McpStdioFixture(),
  mcp_http: () => new McpHttpFixture(),
  skill_package: () => new SkillPackageFixture(),
  issue_feed: () => new IssueFeedFixture(),
  email_feed: () => new EmailFeedFixture(),
};

/** Kinds with a concrete inert fixture in this build. */
export const IMPLEMENTED_FIXTURES = Object.keys(registry) as FixtureKind[];

/** Construct the fixture for one FixtureRef. Throws for a kind not implemented in 0.1. */
export function buildFixture(ref: FixtureRef): Fixture {
  const make = registry[ref.type];
  if (!make) {
    throw new Error(
      `fixture "${ref.type}" is not implemented in 0.1 (implemented: ${IMPLEMENTED_FIXTURES.join(', ')})`,
    );
  }
  return make();
}

/** A FixtureProvider for the runner: build every fixture a scenario declares. */
export function fixturesForScenario(scenario: Scenario): Fixture[] {
  return (scenario.fixtures ?? []).map(buildFixture);
}
