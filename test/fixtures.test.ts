// Fixture inertness tests (ADR-0002; CLAUDE.md). The three invariants live in FixtureBase and
// are proven here against the standalone helpers and a few deliberately-bad fixtures: a
// loopback-only endpoint rule (a), live-credential rejection (b), and the no-self-call guard
// (c). The InMemoryNoopFixture (a test helper) stands in for a real inert fixture.

import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

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
import { WebServerFixture, ENV_WEB_URL, WEB_PLACEHOLDER } from '../src/fixtures/webServer.js';
import { FixtureCanaryError } from '../src/fixtures/fixture.js';
import { FixtureParamsError } from '../src/fixtures/params.js';
import {
  LocalRegistryFixture,
  ENV_NPM_REGISTRY,
  REGISTRY_ACCESS_LOG,
  CANARY_PACKAGE_VERSION,
} from '../src/fixtures/localRegistry.js';
import { buildFixture, IMPLEMENTED_FIXTURES } from '../src/fixtures/index.js';
import type { Fixture } from '../src/fixtures/fixture.js';
import { mkScratch, TEST_WORK_ROOT } from './helpers/scratch.js';

// Never created: a fixture that appends to <runDir> (local_registry access log) fails silently
// instead of writing anywhere, and the path is repo-local, never under /tmp (evidence-spec s2.1).
const NOOP_BASE = path.join(TEST_WORK_ROOT, 'never-created');
const ctx: FixtureContext = { runDir: path.join(NOOP_BASE, 'run'), workdir: path.join(NOOP_BASE, 'work') };

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
    // `@` in the path is not userinfo: the host of http://evil.com/@127.0.0.1 is evil.com.
    for (const bad of ['evil.com', 'http://example.com/x', '10.0.0.5:9000', '169.254.169.254', 'http://evil.com/@127.0.0.1']) {
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

// --- web_server + local_registry (ADR-0002) ---------------------------------------------

/** Parse a ustar archive into path -> content (regular files only). */
function untar(tar: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let off = 0;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('ascii').replace(/\0.*$/s, '');
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, ''), 8);
    const stored = parseInt(h.subarray(148, 156).toString('ascii').replace(/[\0 ].*$/s, ''), 8);
    const forSum = Buffer.from(h);
    forSum.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of forSum) sum += b;
    expect(sum).toBe(stored);
    expect(h.subarray(257, 262).toString('ascii')).toBe('ustar');
    off += 512;
    out.set(name, tar.subarray(off, off + size).toString('utf8'));
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

/** Whether a TCP port on 127.0.0.1 can be bound again (i.e. the fixture released it). */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

const live: Fixture[] = [];
afterEach(async () => {
  for (const f of live.splice(0)) await f.teardown();
});

describe('WebServerFixture (web_server)', () => {
  it('binds loopback and serves the static page with the canary marker and placeholder', async () => {
    const f = new WebServerFixture();
    live.push(f);
    const p = await f.provision(ctx);
    const url = new URL(p.canaries.url);
    expect(url.hostname).toBe('127.0.0.1');
    expect(p.profilePatch?.env?.[ENV_WEB_URL]).toBe(p.canaries.url);
    expect(p.canaries.marker).toMatch(/^aab-web-[0-9a-f]{24}$/);

    const res = await fetch(p.canaries.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html).toContain(p.canaries.marker);
    expect(html).toContain(WEB_PLACEHOLDER);
    expect(html).not.toMatch(/<script|<iframe|<link|<img|src=|href=|https?:\/\//i);

    expect((await fetch(new URL('/other', url))).status).toBe(404);
    expect((await fetch(url, { method: 'POST' })).status).toBe(405);
  });

  it('yields a different marker on each provision', async () => {
    const a = new WebServerFixture();
    const b = new WebServerFixture();
    live.push(a, b);
    const pa = await a.provision(ctx);
    const pb = await b.provision(ctx);
    expect(pa.canaries.marker).not.toBe(pb.canaries.marker);
  });

  it('default (no params) renders no instruction paragraph and no command path', async () => {
    const f = new WebServerFixture();
    live.push(f);
    expect(f.instruction).toBe('none');
    const commandPath = '/opt/aab-run/canary_bin/aab-canary-noop';
    const p = await f.provision({ ...ctx, canaries: { commandPath } });
    const html = await (await fetch(p.canaries.url)).text();
    expect(html).not.toContain(commandPath);
    expect(html).not.toContain('aab-instruction');
    expect(html).not.toContain('Placeholder instruction');
    expect(p.canaries.command).toBeUndefined();
  });

  it('instruction: command renders one visible inert paragraph naming ctx.canaries.commandPath', async () => {
    const f = new WebServerFixture({ instruction: 'command' });
    live.push(f);
    const commandPath = '/opt/aab-run/canary_bin/aab-canary-noop';
    const p = await f.provision({ ...ctx, canaries: { commandPath } });
    expect(p.canaries.command).toBe(commandPath);
    const res = await fetch(p.canaries.url);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
    const html = await res.text();
    const para = /<p id="aab-instruction">([^<]*)<\/p>/.exec(html);
    expect(para).not.toBeNull();
    expect(para![1]).toContain(`\`${commandPath}\``);
    expect(para![1].toLowerCase()).toContain('inert');
    expect(/^[\x20-\x7e]*$/.test(para![1])).toBe(true);
    expect(html.split(commandPath)).toHaveLength(2); // named exactly once
    expect(html).toContain(p.canaries.marker);
    expect(html).toContain(WEB_PLACEHOLDER);
    expect(html).not.toMatch(/<script|<iframe|<link|<img|src=|href=|https?:\/\//i);
  });

  it('instruction: command without ctx.canaries.commandPath throws FixtureCanaryError', async () => {
    for (const c of [ctx, { ...ctx, canaries: {} }]) {
      const f = new WebServerFixture({ instruction: 'command' });
      live.push(f);
      await expect(f.provision(c)).rejects.toBeInstanceOf(FixtureCanaryError);
    }
  });

  it('rejects unknown params / values with FixtureParamsError', () => {
    expect(() => new WebServerFixture({ instruction: 'free text' })).toThrow(FixtureParamsError);
    expect(() => new WebServerFixture({ extra: 1 })).toThrow(FixtureParamsError);
  });

  it('teardown closes the server and frees the port', async () => {
    const f = new WebServerFixture();
    const p = await f.provision(ctx);
    await fetch(p.canaries.url).then((r) => r.text()); // leave a keep-alive socket open
    const port = Number(new URL(p.canaries.url).port);
    await f.teardown();
    expect(await portIsFree(port)).toBe(true);
  });
});

describe('LocalRegistryFixture (local_registry)', () => {
  it('binds loopback and sets the npm registry env var', async () => {
    const f = new LocalRegistryFixture();
    live.push(f);
    const p = await f.provision(ctx);
    expect(new URL(p.canaries.registry_url).hostname).toBe('127.0.0.1');
    expect(new URL(p.canaries.tarball_url).hostname).toBe('127.0.0.1');
    expect(p.profilePatch?.env?.[ENV_NPM_REGISTRY]).toBe(p.canaries.registry_url);
    expect(p.canaries.package).toMatch(/^aab-canary-[0-9a-f]{16}$/);
  });

  it('serves a packument and a tarball whose integrity and shasum verify', async () => {
    const f = new LocalRegistryFixture();
    live.push(f);
    const p = await f.provision(ctx);
    const name = p.canaries.package;

    const res = await fetch(new URL(name, p.canaries.registry_url));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      name: string;
      'dist-tags': { latest: string };
      versions: Record<string, { name: string; version: string; scripts?: unknown; dist: { tarball: string; integrity: string; shasum: string } }>;
    };
    expect(doc.name).toBe(name);
    expect(doc['dist-tags'].latest).toBe(CANARY_PACKAGE_VERSION);
    expect(Object.keys(doc.versions)).toEqual([CANARY_PACKAGE_VERSION]);
    const v = doc.versions[CANARY_PACKAGE_VERSION];
    expect(v.name).toBe(name);
    expect(v.scripts).toBeUndefined();
    expect(v.dist.tarball).toBe(p.canaries.tarball_url);

    const tres = await fetch(v.dist.tarball);
    expect(tres.status).toBe(200);
    const tgz = Buffer.from(await tres.arrayBuffer());
    expect(v.dist.integrity).toBe(`sha512-${createHash('sha512').update(tgz).digest('base64')}`);
    expect(v.dist.shasum).toBe(createHash('sha1').update(tgz).digest('hex'));

    const files = untar(gunzipSync(tgz));
    expect([...files.keys()].sort()).toEqual(['package/index.js', 'package/package.json']);
    expect(files.get('package/index.js')).toBe('');
    const pkg = JSON.parse(files.get('package/package.json')!) as Record<string, unknown>;
    expect(pkg.name).toBe(name);
    expect(pkg.version).toBe(CANARY_PACKAGE_VERSION);
    for (const k of ['scripts', 'bin', 'dependencies', 'optionalDependencies']) {
      expect(pkg[k]).toBeUndefined();
    }
  });

  it('is read-only and 404s unknown packages', async () => {
    const f = new LocalRegistryFixture();
    live.push(f);
    const p = await f.provision(ctx);
    expect((await fetch(new URL('left-pad', p.canaries.registry_url))).status).toBe(404);
    const put = await fetch(new URL(p.canaries.package, p.canaries.registry_url), {
      method: 'PUT',
      body: '{}',
    });
    expect(put.status).toBe(405);
  });

  it('yields a different canary package on each provision', async () => {
    const a = new LocalRegistryFixture();
    const b = new LocalRegistryFixture();
    live.push(a, b);
    const pa = await a.provision(ctx);
    const pb = await b.provision(ctx);
    expect(pa.canaries.package).not.toBe(pb.canaries.package);
  });

  it('logs one JSON line per request (method, path, time, kind) into the run dir', async () => {
    const runDir = await mkScratch('aab-reg-log-');
    const f = new LocalRegistryFixture();
    live.push(f);
    try {
      const p = await f.provision({ ...ctx, runDir });
      expect(p.canaries.registry_access_log).toBe(path.join(runDir, REGISTRY_ACCESS_LOG));
      await fetch(new URL(p.canaries.package, p.canaries.registry_url)).then((r) => r.text());
      await fetch(p.canaries.tarball_url).then((r) => r.arrayBuffer());
      await fetch(new URL('left-pad?x=1', p.canaries.registry_url)).then((r) => r.text());
      const lines = (await readFile(p.canaries.registry_access_log, 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { method: string; path: string; time: number; kind: string });
      const own = lines;
      expect(own.map((l) => l.kind)).toEqual(['packument', 'tarball', 'other']);
      expect(own.map((l) => l.path)).toEqual([
        `/${p.canaries.package}`,
        new URL(p.canaries.tarball_url).pathname,
        '/left-pad',
      ]);
      for (const l of own) {
        expect(l.method).toBe('GET');
        expect(typeof l.time).toBe('number');
      }
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('uses the sensor-handed canary package name and rejects a non-canary name', async () => {
    const f = new LocalRegistryFixture();
    live.push(f);
    const name = 'aab-canary-0123456789abcdef';
    const p = await f.provision({ ...ctx, canaries: { package: name } });
    expect(p.canaries.package).toBe(name);
    expect(p.canaries.tarball_url).toContain(`/${name}/-/${name}-1.0.0.tgz`);
    const g = new LocalRegistryFixture();
    live.push(g);
    await expect(g.provision({ ...ctx, canaries: { package: 'left-pad' } })).rejects.toThrow(/canary package name/);
  });

  it('teardown closes the server and frees the port', async () => {
    const f = new LocalRegistryFixture();
    const p = await f.provision(ctx);
    await fetch(new URL(p.canaries.package, p.canaries.registry_url)).then((r) => r.text());
    const port = Number(new URL(p.canaries.registry_url).port);
    await f.teardown();
    expect(await portIsFree(port)).toBe(true);
  });
});

describe('buildFixture for web_server and local_registry', () => {
  it('builds both kinds and lists them as implemented', () => {
    expect(IMPLEMENTED_FIXTURES).toEqual(expect.arrayContaining(['web_server', 'local_registry']));
    const web = buildFixture({ type: 'web_server' });
    const reg = buildFixture({ type: 'local_registry' });
    expect(web).toBeInstanceOf(WebServerFixture);
    expect(web.type).toBe('web_server');
    expect(reg).toBeInstanceOf(LocalRegistryFixture);
    expect(reg.type).toBe('local_registry');
  });
});

describe('loopbackHttp (shared bind for web_server/local_registry)', () => {
  it('binds the actual listening socket to 127.0.0.1 only, for both fixtures', async () => {
    // Check the real socket address, not the URL string the fixture builds from it.
    for (const f of [new WebServerFixture(), new LocalRegistryFixture()]) {
      live.push(f);
      await f.provision(ctx);
      const addr = (f as unknown as { server: import('node:http').Server }).server.address();
      expect(addr && typeof addr === 'object' ? addr.address : addr).toBe('127.0.0.1');
    }
  });
});
