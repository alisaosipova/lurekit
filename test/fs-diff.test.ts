// ENGINE-12: fs_diff hashes watched files streaming, with byte bounds.
import { describe, expect, it } from 'vitest';

describe('ENGINE-12: bounded streaming hash', () => {
  it('equals sha256 of the content below the cap; a larger file hashes the prefix plus its size', async () => {
    const { hashFileBounded } = await import('../src/detectors/fsDiff.js');
    const { createHash } = await import('node:crypto');
    const { writeFile: wf } = await import('node:fs/promises');
    const { mkScratch, rmScratch } = await import('./helpers/scratch.js');
    const dir = await mkScratch('fsdiff-hash-');
    try {
      const f = (await import('node:path')).join(dir, 'x');
      const body = Buffer.alloc(300_000, 7);
      await wf(f, body);
      expect(await hashFileBounded(f, body.length)).toBe(createHash('sha256').update(body).digest('hex'));
      const capped = await hashFileBounded(f, body.length, 1000);
      expect(capped).toBe(createHash('sha256').update(body.subarray(0, 1000)).update(`\ntruncated:${body.length}`).digest('hex'));
      expect(await hashFileBounded(f, 0)).toBe(createHash('sha256').digest('hex'));
    } finally {
      await rmScratch(dir);
    }
  });
});
