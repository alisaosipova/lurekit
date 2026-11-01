// Test-only fixture: a trivial, fully inert FixtureBase subclass used to exercise the runner
// lifecycle without any real attack surface. It lives under test/ (not src/) per the step-4
// brief: the 0.1 schema's FixtureKind enum is NOT changed, so this reuses an existing value
// ('web_server') while serving nothing at all — it stands up no server, binds no port, and
// returns only a random non-secret marker on loopback.

import { randomBytes } from 'node:crypto';

import { FixtureBase, type FixtureContext, type FixtureProvision } from '../../src/fixtures/fixture.js';
import type { FixtureKind } from '../../src/scenario/types.js';
import type { SetupProfile } from '../../src/adapters/adapter.js';

export class InMemoryNoopFixture extends FixtureBase {
  readonly type: FixtureKind = 'web_server';
  readonly marker = `aab-noop-${randomBytes(8).toString('hex')}`;
  teardownCalls = 0;

  constructor(private readonly profilePatch?: Partial<SetupProfile>) {
    super();
  }

  protected async provisionInert(_ctx: FixtureContext): Promise<FixtureProvision> {
    return {
      canaries: { marker: this.marker, host: '127.0.0.1' },
      profilePatch: this.profilePatch,
    };
  }

  async teardown(): Promise<void> {
    this.teardownCalls += 1;
  }
}
