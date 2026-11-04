// Content digests over scenarios (evidence-spec s2.3, s5). Shared by the runner (which records
// corpus_digest in the manifest) and publish (which recomputes it over the published scenarios
// when --withhold/--exclude drop some, ADR-0017 "Corpus block of a reduced bundle").

import { createHash } from 'node:crypto';

import type { Scenario } from './types.js';

/** sha256 (hex) of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Canonical JSON with recursively sorted object keys, so a content hash is independent of key
 *  order. undefined is encoded as null (JSON has no undefined). */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value ?? null;
}

/** sha256 over the sorted scenario serializations, stable across processes (s5). */
export function corpusDigest(scenarios: Scenario[]): string {
  const sorted = [...scenarios].sort((a, b) => a.id.localeCompare(b.id)).map((s) => canonical(s));
  return sha256Hex(sorted.join('\n'));
}
