// Block B10 ENGINE-05 (ADR-0025 D1): concurrent requests to a sink must leave a witness equal to
// the file, so verify() never reports a spurious `modified` (which in registry mode would make a
// clean run inconclusive(evidence_tampered)).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { serialSinkAppender } from '../src/detectors/util.js';
import { getDetector } from '../src/detectors/index.js';
import { mkScratch, rmScratch } from './helpers/scratch.js';

let dir: string;
beforeEach(async () => {
  dir = await mkScratch('sink-order-');
});
afterEach(async () => {
  await rmScratch(dir);
});

describe('serialised sink appends (B10 ENGINE-05)', () => {
  it('serialSinkAppender: 200 concurrent appends, the witness equals the file byte for byte', async () => {
    const f = path.join(dir, 'sink.log');
    const s = serialSinkAppender(f);
    await Promise.all(Array.from({ length: 200 }, (_, i) => s.append(`${JSON.stringify({ i, pad: 'x'.repeat(i % 37) })}\n`)));
    expect(await readFile(f, 'utf8')).toBe(s.witness());
  });
  it('canary_egress_http: 20 concurrent GETs, the access-log witness equals the file', async () => {
    const det = getDetector('canary_egress_http');
    const prov = await det.provision('sink-order', dir);
    try {
      const url = prov.canaries.url;
      await Promise.all(Array.from({ length: 20 }, (_, i) => fetch(`${url}?n=${i}`).then((r) => r.arrayBuffer())));
      const decl = (prov.artefacts ?? []).find((a) => a.kind === 'sink' && a.witness);
      expect(decl).toBeDefined();
      const text = await readFile(path.join(dir, decl!.path), 'utf8');
      expect(text.split('\n').filter(Boolean)).toHaveLength(20);
      expect(text).toBe(decl!.witness!());
    } finally {
      await prov.teardown();
    }
  });
});

describe('SECURITY-09: sinks are never written through a symlink', () => {
  it.skipIf(process.platform === 'win32')('a sink replaced by a symlink before the first append is not followed', async () => {
    const { symlink, writeFile: wf, readFile: rf } = await import('node:fs/promises');
    const victim = path.join(dir, 'victim.txt');
    await wf(victim, 'untouched\n');
    const sinkPath = path.join(dir, 'sink.log');
    await symlink(victim, sinkPath);
    const s = serialSinkAppender(sinkPath);
    await expect(s.append('line\n')).rejects.toThrow();
    expect(await rf(victim, 'utf8')).toBe('untouched\n');
    expect(s.witness()).toBe('');
    await s.close();
  });
});
