// Scenario loader + validator: "add a scenario = one validated file" (BOOTSTRAP.md step 1).
//
// compileValidator()   builds a strict ajv (2020-12) with uri/date formats and compiles
//                       schemas/scenario.schema.json.
// loadScenarioFile()    parses one YAML file, schema-validates it, returns a typed Scenario.
// loadScenarioDir()     loads every *.yaml/*.yml in a dir and enforces the cross-file
//                       invariants the JSON Schema cannot express (incl. task placeholder
//                       syntax, evidence-spec §4.1).

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

import _Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { parse as parseYaml } from 'yaml';

import type { Scenario } from './types.js';
import { malformedPlaceholders } from './taskTemplate.js';

// ajv's CJS build sets both `module.exports` and `.default` to the class; unwrap either.
type AjvCtor = new (opts: Record<string, unknown>) => {
  addFormat(name: string, format: { type?: string; validate: (v: string) => boolean }): unknown;
  compile<T = unknown>(schema: unknown): ValidateFunction<T>;
};
const Ajv2020 = ((_Ajv2020 as unknown as { default?: AjvCtor }).default ?? _Ajv2020) as AjvCtor;

const require = createRequire(import.meta.url);

// The schema lives at <repo>/schemas; this module sits two levels down in both
// src/scenario (vitest/tsx) and dist/scenario (built), so the relative URL is stable.
const SCHEMA_PATH = fileURLToPath(new URL('../../schemas/scenario.schema.json', import.meta.url));

export class ScenarioValidationError extends Error {
  readonly file: string;
  readonly errors: string[];
  constructor(file: string, errors: string[]) {
    super(`scenario validation failed for ${file}:\n  ${errors.join('\n  ')}`);
    this.name = 'ScenarioValidationError';
    this.file = file;
    this.errors = errors;
  }
}

/** Build an ajv instance (strict mode) that knows the "uri" and "date" formats and
 *  compiles the scenario schema. Uses ajv-formats when installed, otherwise registers
 *  minimal inline format checkers so strict mode does not throw on an unknown format. */
export function compileValidator(): ValidateFunction<Scenario> {
  const ajv = new Ajv2020({ strict: true, allErrors: true });

  let formatsRegistered = false;
  try {
    const mod = require('ajv-formats') as unknown;
    const addFormats = ((mod as { default?: unknown }).default ?? mod) as (
      ajv: unknown,
      opts?: string[],
    ) => unknown;
    addFormats(ajv, ['uri', 'date']);
    formatsRegistered = true;
  } catch {
    // ajv-formats not available — fall through to inline checkers.
  }

  if (!formatsRegistered) {
    // Minimal, permissive checkers: enough that strict mode accepts the "format" keyword.
    ajv.addFormat('uri', {
      type: 'string',
      validate: (v: string) => /^[a-z][a-z0-9+.-]*:/i.test(v),
    });
    ajv.addFormat('date', {
      type: 'string',
      validate: (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v),
    });
  }

  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>;
  return ajv.compile<Scenario>(schema);
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) return ['unknown validation error'];
  return errors.map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`.trim());
}

// Compile once; the validator is stateless and reusable across files.
let cachedValidator: ValidateFunction<Scenario> | undefined;
function validator(): ValidateFunction<Scenario> {
  if (!cachedValidator) cachedValidator = compileValidator();
  return cachedValidator;
}

/** Read, parse and schema-validate one scenario file. Throws ScenarioValidationError on
 *  parse or schema failure; returns the typed Scenario on success. */
export function loadScenarioFile(file: string): Scenario {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new ScenarioValidationError(file, [`cannot read file: ${(err as Error).message}`]);
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new ScenarioValidationError(file, [`YAML parse error: ${(err as Error).message}`]);
  }

  const validate = validator();
  if (!validate(data)) {
    throw new ScenarioValidationError(file, formatErrors(validate.errors));
  }
  return data as Scenario;
}

export interface LoadDirError {
  file: string;
  message: string;
}

export interface LoadDirResult {
  scenarios: Scenario[];
  errors: LoadDirError[];
}

/** Load every *.yaml/*.yml in `dir` (non-recursive, sorted) and enforce cross-file
 *  invariants the JSON Schema cannot: unique id, id == filename stem, browser track is
 *  never runnable, and a default of "full" for an absent headless_fidelity. Never throws:
 *  failures (schema or invariant) are collected in `errors`; `scenarios` holds only the
 *  fully-valid ones. */
export function loadScenarioDir(dir: string): LoadDirResult {
  const errors: LoadDirError[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    return { scenarios: [], errors: [{ file: dir, message: `cannot read dir: ${(err as Error).message}` }] };
  }

  const files = entries
    .filter((f) => /\.(ya?ml)$/i.test(f))
    .sort((a, b) => a.localeCompare(b));

  // Phase 1: parse + schema-validate; remember the id each file *claims* for the dup check.
  const parsed: Array<{ file: string; stem: string; scenario: Scenario }> = [];
  const idToFiles = new Map<string, string[]>();

  for (const name of files) {
    const full = path.join(dir, name);
    const stem = name.replace(/\.(ya?ml)$/i, '');
    try {
      const scenario = loadScenarioFile(full);
      parsed.push({ file: name, stem, scenario });
      const list = idToFiles.get(scenario.id) ?? [];
      list.push(name);
      idToFiles.set(scenario.id, list);
    } catch (err) {
      const e = err as ScenarioValidationError;
      errors.push({ file: name, message: e.errors ? e.errors.join('; ') : e.message });
    }
  }

  const duplicateIds = new Set(
    [...idToFiles.entries()].filter(([, list]) => list.length > 1).map(([id]) => id),
  );

  // Phase 2: per-file invariants + dup check; only clean files become scenarios.
  const scenarios: Scenario[] = [];
  for (const { file, stem, scenario } of parsed) {
    const fileErrors: string[] = [];

    if (duplicateIds.has(scenario.id)) {
      fileErrors.push(
        `duplicate id ${scenario.id} (also in ${idToFiles
          .get(scenario.id)!
          .filter((f) => f !== file)
          .join(', ')})`,
      );
    }
    if (scenario.id !== stem) {
      fileErrors.push(`id ${scenario.id} does not match filename stem ${stem}`);
    }
    // Browser-track rows are never runnable in 0.1. The schema defaults `runnable`
    // to true, so an omitted value means runnable:true — reject anything but an
    // explicit false, not just an explicit true.
    if (scenario.track === 'browser' && scenario.runnable !== false) {
      fileErrors.push('track "browser" requires runnable:false');
    }

    // Task placeholders (evidence-spec §4.1): only {{env.NAME}} / {{canary.KEY}} are allowed.
    for (const bad of malformedPlaceholders(scenario.task)) {
      fileErrors.push(`task has a malformed placeholder: ${bad} (allowed: {{env.NAME}}, {{canary.KEY}})`);
    }

    if (fileErrors.length > 0) {
      for (const message of fileErrors) errors.push({ file, message });
      continue;
    }

    // Invariant (d): apply schema defaults the loader is responsible for, so
    // consumers never see an absent value where the schema declares a default:
    //   - headless_fidelity defaults to "full"
    //   - runnable defaults to true (the browser invariant above already forced
    //     any browser-track row to carry an explicit runnable:false)
    scenarios.push({
      ...scenario,
      runnable: scenario.runnable ?? true,
      headless_fidelity: scenario.headless_fidelity ?? 'full',
    });
  }

  return { scenarios, errors };
}
