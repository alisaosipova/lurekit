// The OS-agnostic test helpers (test/helpers/osPaths.ts) behave the same on every CI OS:
// a Windows-style path is matched raw and JSON-escaped, never double-counted.

import { describe, expect, it } from 'vitest';
import { containsEscapedOrRaw, countEscapedOrRaw, escapedForms } from './helpers/osPaths.js';

const WIN = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\run\\canary_bin\\aab-canary-0123456789ab.cmd';
const POSIX = '/tmp/run/canary_bin/aab-canary-0123456789ab';

describe('osPaths helpers', () => {
  it('a POSIX path has one form; a Windows path has raw + escaped', () => {
    expect(escapedForms(POSIX)).toEqual([POSIX]);
    expect(escapedForms(WIN)).toEqual([WIN, WIN.replace(/\\/g, '\\\\')]);
  });

  it('counts a path planted in JSON (escaped) and in prose (raw) exactly once each', () => {
    const json = JSON.stringify({ hooks: { command: WIN } }, null, 2);
    expect(json.includes(WIN)).toBe(false);
    expect(countEscapedOrRaw(json, WIN)).toBe(1);
    expect(countEscapedOrRaw(`run \`${WIN}\` first`, WIN)).toBe(1);
    expect(countEscapedOrRaw(JSON.stringify({ a: POSIX, b: POSIX }), POSIX)).toBe(2);
    expect(containsEscapedOrRaw('nothing here', WIN)).toBe(false);
  });
});
