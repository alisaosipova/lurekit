// Block B17 FEATURE-07: every committed report.json (reports/*, demo/*) and a freshly rendered one
// validate against schemas/report-file.schema.json (manifest + scoring block).
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import _Ajv2020 from 'ajv/dist/2020.js';

type AjvCtor = new (opts?: Record<string, unknown>) => { addSchema(s: unknown): unknown; compile(s: unknown): ((d: unknown) => boolean) & { errors?: unknown[] | null } };
const Ajv2020 = ((_Ajv2020 as unknown as { default?: AjvCtor }).default ?? _Ajv2020) as unknown as AjvCtor;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const schema = (n: string) => JSON.parse(readFileSync(path.join(ROOT, 'schemas', n), 'utf8'));

describe('report-file.schema.json (B17 FEATURE-07)', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addSchema(schema('manifest.schema.json'));
  ajv.addSchema(schema('report.schema.json'));
  const validate = ajv.compile(schema('report-file.schema.json'));
  const files = ['reports', 'demo'].flatMap((d) =>
    readdirSync(path.join(ROOT, d), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name, 'report.json')),
  );
  it.each(files)('%s validates', (f) => {
    const ok = validate(JSON.parse(readFileSync(path.join(ROOT, f), 'utf8')));
    expect(ok, JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
  });
  it('a report.json missing the score block is rejected', () => {
    expect(validate({ manifest: {} })).toBe(false);
  });
});
