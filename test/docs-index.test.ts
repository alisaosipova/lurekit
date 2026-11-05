// Block B18 DOCS-07: every standalone ADR is listed in the docs index.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('docs/README.md lists every ADR file (B18 DOCS-07)', () => {
  const index = readFileSync(path.join(ROOT, 'docs', 'README.md'), 'utf8');
  const adrs = readdirSync(path.join(ROOT, 'docs', 'design')).filter((f) => /^adr-\d{4}-.*\.md$/.test(f));
  it.each(adrs)('%s', (f) => {
    expect(index).toContain(`(design/${f})`);
  });
});
