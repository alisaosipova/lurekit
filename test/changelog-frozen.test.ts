// ADR-0012 amendment (2026-11-05, block B15, rule c), test plan B15-T5: the pure functions of
// scripts/changelog-frozen.mjs. The end-to-end run against the repository is the hygiene job
// (fetch-depth: 0) and `npm run changelog:check` locally, not this file: the CI test job's
// shallow checkout has no tags, where the script must fail closed instead of passing.

import { describe, it, expect } from 'vitest';

// The script is plain JS with no types; the two exports are tested through their behaviour.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore no declaration file for the script
import { compareSections, extractSection } from '../scripts/changelog-frozen.mjs';

const extract = extractSection as (text: string, version: string) => string[] | null;
const compare = compareSections as (a: string[] | null, b: string[] | null) => { equal: boolean; diff: string[] };

const DOC = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '- pending',
  '',
  '## [1.1.0] - 2026-11-03',
  '',
  '### Added',
  '- one',
  '- two',
  '',
  '',
  '## [1.0.0] - 2026-11-03',
  '',
  '- first',
  '',
  '[Unreleased]: https://example.invalid/compare/v1.1.0...HEAD',
  '[1.1.0]: https://example.invalid/compare/v1.0.0...v1.1.0',
  '[1.0.0]: https://example.invalid/releases/tag/v1.0.0',
].join('\n');

describe('extractSection', () => {
  it('a section bounded by the next heading, trailing blank lines trimmed', () => {
    expect(extract(DOC, '1.1.0')).toEqual(['## [1.1.0] - 2026-11-03', '', '### Added', '- one', '- two']);
  });

  it('the last section is bounded by the first link-definition line (the footer is excluded)', () => {
    expect(extract(DOC, '1.0.0')).toEqual(['## [1.0.0] - 2026-11-03', '', '- first']);
  });

  it('a missing section is null; the heading must match the exact version', () => {
    expect(extract(DOC, '1.2.0')).toBeNull();
    expect(extract(DOC, '1.1')).toBeNull();
    expect(extract(DOC, '1.1.0-rc.1')).toBeNull();
  });

  it('CRLF input is normalised and a heading without a date still matches', () => {
    expect(extract('## [2.0.0]\r\n- x\r\n\r\n## [1.9.0]\r\n', '2.0.0')).toEqual(['## [2.0.0]', '- x']);
  });
});

describe('compareSections', () => {
  it('equal sections compare equal', () => {
    expect(compare(extract(DOC, '1.1.0'), extract(DOC, '1.1.0'))).toEqual({ equal: true, diff: [] });
  });

  it('a one-character change is a mismatch with the diff naming both lines', () => {
    const changed = DOC.replace('- two', '- twO');
    const r = compare(extract(DOC, '1.1.0'), extract(changed, '1.1.0'));
    expect(r.equal).toBe(false);
    expect(r.diff).toContain('-- two');
    expect(r.diff).toContain('+- twO');
  });

  it('an added bullet (the DOCS-01 shape) is a mismatch', () => {
    const added = DOC.replace('- two\n', '- two\n- three (added after the tag)\n');
    const r = compare(extract(DOC, '1.1.0'), extract(added, '1.1.0'));
    expect(r.equal).toBe(false);
    expect(r.diff).toContain('+- three (added after the tag)');
  });

  it('a section missing on either side is a mismatch, never equal (fail closed)', () => {
    expect(compare(null, extract(DOC, '1.1.0')).equal).toBe(false);
    expect(compare(extract(DOC, '1.1.0'), null).equal).toBe(false);
    expect(compare(null, null).equal).toBe(false);
  });

  it('a change in the link footer alone does not affect the last section', () => {
    const footer = DOC.replace('[1.0.0]: https://example.invalid/releases/tag/v1.0.0', '[1.0.0]: https://example.invalid/moved');
    expect(compare(extract(DOC, '1.0.0'), extract(footer, '1.0.0')).equal).toBe(true);
  });
});
