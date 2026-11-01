// Fixture inertness tests (ADR-0002; CLAUDE.md). The three invariants live in FixtureBase and
// are proven here against the standalone helpers and a few deliberately-bad fixtures: a
// loopback-only endpoint rule (a), live-credential rejection (b), and the no-self-call guard
// (c). The InMemoryNoopFixture (a test helper) stands in for a real inert fixture.

import { describe, it, expect } from 'vitest';

import {
  FixtureBase,
  FixtureInertnessError,
  assertLoopback,
  assertNoRealSecret,
  type FixtureContext,
  type FixtureProvision,
} from '../src/fixtures/fixture.js';
import type { FixtureKind } from '../src/scenario/types.js';
import { InMemoryNoopFixture } from './helpers/inMemoryNoopFixture.js';

const ctx: FixtureContext = { runDir: '/tmp/aab-noop-run', workdir: '/tmp/aab-noop-work' };

describe('assertLoopback (invariant a)', () => {
  it('accepts loopback hosts, host:port and URLs', () => {
    for (const ok of [
      '127.0.0.1',
      'localhost',
      '::1',
      '127.0.0.1:8080',
      '[::1]:3000',
      'http://127.0.0.1:5173/c/abc?x=1',
      'http://localhost/page',
    ]) {
      expect(() => assertLoopback(ok)).not.toThrow();
    }
  });

  it('rejects non-loopback hosts', () => {
    for (const bad of ['evil.com', 'http://example.com/x', '10.0.0.5:9000', '169.254.169.254']) {
      expect(() => assertLoopback(bad)).toThrow(FixtureInertnessError);
    }
  });

  it('accepts the provided canary host in addition to loopback', () => {
    expect(() => assertLoopback('http://canary.internal/x', 'canary.internal')).not.toThrow();
    expect(() => assertLoopback('http://canary.internal/x')).toThrow(FixtureInertnessError);
  });
});

describe('assertNoRealSecret (invariant b)', () => {
  it('rejects values that look like live credentials', () => {
    const live = [
      'sk-abcdefghijklmnopqrstuvwx1234567890',
      'ghp_0123456789abcdef0123456789abcdef0123',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
      'AKIAIOSFODNN7EXAMPLE',
      'xoxb-123456789012-abcdefghijkl',
      'AIzaSyA1234567890abcdefghijklmnopqrstuvw',
    ];
    for (const s of live) expect(() => assertNoRealSecret(s)).toThrow(FixtureInertnessError);
  });

  it('allows a bare random hex/base64 canary marker (no secret prefix)', () => {
    for (const marker of [
      'a3f9c1d7e2b48f60a3f9c1d7e2b48f60', // 32 hex
      'aab-noop-deadbeefcafebabe',
      'Zm9vYmFyYmF6cXV4', // base64, no prefix
    ]) {
      expect(() => assertNoRealSecret(marker)).not.toThrow();
    }
  });

  it('does not echo the secret in the error message', () => {
    try {
      assertNoRealSecret('ghp_0123456789abcdef0123456789abcdef0123');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FixtureInertnessError);
      expect((err as Error).message).not.toContain('0123456789abcdef');
      expect((err as Error).message).toContain('redacted');
    }
  });
});

describe('FixtureBase enforces inertness on the provisioned result', () => {
  class BadHostFixture extends FixtureBase {
    readonly type: FixtureKind = 'web_server';
    protected async provisionInert(): Promise<FixtureProvision> {
      return { canaries: { url: 'http://evil.example.com/collect' } };
    }
    async teardown(): Promise<void> {}
  }
  class SecretFixture extends FixtureBase {
    readonly type: FixtureKind = 'mcp_stdio';
    protected async provisionInert(): Promise<FixtureProvision> {
      return { canaries: { token: 'ghp_0123456789abcdef0123456789abcdef0123' } };
    }
    async teardown(): Promise<void> {}
  }
  class SecretInPatchFixture extends FixtureBase {
    readonly type: FixtureKind = 'mcp_stdio';
    protected async provisionInert(): Promise<FixtureProvision> {
      return {
        canaries: { marker: 'ok' },
        profilePatch: { env: { API_KEY: 'sk-abcdefghijklmnopqrstuvwx1234567890' } },
      };
    }
    async teardown(): Promise<void> {}
  }

  it('rejects a non-loopback endpoint (a)', async () => {
    await expect(new BadHostFixture().provision(ctx)).rejects.toBeInstanceOf(FixtureInertnessError);
  });
  it('rejects a live-credential canary value (b)', async () => {
    await expect(new SecretFixture().provision(ctx)).rejects.toBeInstanceOf(FixtureInertnessError);
  });
  it('rejects a live credential hidden in the profilePatch (b)', async () => {
    await expect(new SecretInPatchFixture().provision(ctx)).rejects.toBeInstanceOf(
      FixtureInertnessError,
    );
  });
});

describe('FixtureBase.assertNotCanary (invariant c)', () => {
  class SelfCaller extends FixtureBase {
    readonly type: FixtureKind = 'web_server';
    private provisioned = '';
    protected async provisionInert(): Promise<FixtureProvision> {
      this.provisioned = 'aab-noop-canarymarker';
      return { canaries: { marker: this.provisioned, host: '127.0.0.1' } };
    }
    async teardown(): Promise<void> {}
    /** Expose the guard so the test can drive it as a future fixture's egress path would. */
    callTarget(target: string): void {
      this.assertNotCanary(target);
    }
  }

  it('throws if a fixture tries to call its own canary; allows other targets', async () => {
    const f = new SelfCaller();
    await f.provision(ctx);
    expect(() => f.callTarget('http://127.0.0.1:9/aab-noop-canarymarker')).toThrow(
      FixtureInertnessError,
    );
    expect(() => f.callTarget('http://127.0.0.1:9/unrelated')).not.toThrow();
  });

  it('throws if a fixture tries to call the canary host', async () => {
    const f = new SelfCaller();
    await f.provision({ ...ctx, canaryHost: 'canary.internal' });
    expect(() => f.callTarget('http://canary.internal/x')).toThrow(FixtureInertnessError);
  });
});

describe('InMemoryNoopFixture (inert test helper)', () => {
  it('provisions a non-secret loopback marker and tears down cleanly', async () => {
    const f = new InMemoryNoopFixture();
    const result = await f.provision(ctx);
    expect(result.canaries.marker).toMatch(/^aab-noop-/);
    expect(result.canaries.host).toBe('127.0.0.1');
    await f.teardown();
    expect(f.teardownCalls).toBe(1);
  });
});
