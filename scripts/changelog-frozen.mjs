#!/usr/bin/env node
// Released CHANGELOG sections are frozen (ADR-0012 amendment 2026-11-05, block B15, rule c).
//
// For every release tag `v<int>.<int>.<int>` (no pre-release suffix) the `## [X.Y.Z]` section of
// CHANGELOG.md in the working tree must be byte-identical to the same section in CHANGELOG.md at
// that tag: the npm tarball at that version carries the text at the tag, and a reader comparing
// the two must find them equal. A correction discovered after the tag goes to [Unreleased].
//
// A section runs from its `## [X.Y.Z]` heading line to the line before the next `## [` heading
// or the first link-definition line (`[name]: url`), whichever comes first, trailing blank lines
// trimmed. The link footer is excluded on purpose: it legitimately gains a line per release.
//
// Exit 1 (fail closed) on: a mismatch (the unified diff is printed), a tag whose CHANGELOG has
// no section for its version, and no release tag reachable at all (a shallow checkout must not
// pass vacuously; fetch the tags). No dependencies; run as `npm run changelog:check`.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHANGELOG = 'CHANGELOG.md';
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const LINK_DEFINITION = /^\[[^\]]+\]: /;

/** The `## [version]` section of a CHANGELOG text, as an array of lines; null when absent. */
export function extractSection(text, version) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const heading = `## [${version}]`;
  const start = lines.findIndex((l) => l === heading || l.startsWith(`${heading} `));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## [') || LINK_DEFINITION.test(lines[i])) {
      end = i;
      break;
    }
  }
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end);
}

/** Compare two extracted sections; returns `{ equal: true }` or the unified-style diff lines. */
export function compareSections(atTag, working) {
  if (atTag === null) return { equal: false, diff: ['section missing at the tag'] };
  if (working === null) return { equal: false, diff: ['section missing in the working tree'] };
  const a = atTag.join('\n');
  const b = working.join('\n');
  if (a === b) return { equal: true, diff: [] };
  return { equal: false, diff: unifiedDiff(atTag, working) };
}

/** Minimal line diff (LCS), printed in the unified style; the sections are short. */
function unifiedDiff(a, b) {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = ['--- at tag', '+++ working tree'];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push(`+${b[j]}`);
      j += 1;
    } else {
      out.push(`-${a[i]}`);
      i += 1;
    }
  }
  return out;
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function releaseTags() {
  const tags = git(['tag', '--list', 'v*'])
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => RELEASE_TAG.test(t));
  const key = (t) => t.slice(1).split('.').map((x) => Number.parseInt(x, 10));
  return tags.sort((x, y) => {
    const [a, b] = [key(x), key(y)];
    for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  });
}

function main() {
  const tags = releaseTags();
  if (tags.length === 0) {
    console.error(`FAIL: no release tag v<int>.<int>.<int> reachable; fetch the tags (git fetch --tags) before running ${path.basename(process.argv[1])}`);
    return 1;
  }
  const working = readFileSync(path.join(ROOT, CHANGELOG), 'utf8');
  let failures = 0;
  for (const tag of tags) {
    const version = tag.slice(1);
    let atTagText;
    try {
      atTagText = git(['show', `${tag}:${CHANGELOG}`]);
    } catch (e) {
      console.error(`FAIL: ${tag}: cannot read ${CHANGELOG} at the tag: ${(e && e.message) || String(e)}`);
      failures += 1;
      continue;
    }
    const atTag = extractSection(atTagText, version);
    const now = extractSection(working, version);
    if (atTag === null) {
      console.error(`FAIL: ${tag}: ${CHANGELOG} at the tag has no "## [${version}]" section (a release without notes)`);
      failures += 1;
      continue;
    }
    const r = compareSections(atTag, now);
    if (!r.equal) {
      console.error(`FAIL: ${tag}: section "## [${version}]" differs from ${CHANGELOG} at the tag; released sections are frozen (ADR-0012), move the change to [Unreleased]`);
      for (const line of r.diff) console.error(line);
      failures += 1;
      continue;
    }
    console.log(`ok: ${tag}: "## [${version}]" (${atTag.length} lines) equals the text at the tag`);
  }
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
