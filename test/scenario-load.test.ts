import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  loadScenarioFile,
  loadScenarioDir,
  ScenarioValidationError,
} from '../src/scenario/load.js';

const fixtureDir = (sub: string) =>
  fileURLToPath(new URL(`./fixtures/scenarios/${sub}`, import.meta.url));
const realScenario = (name: string) =>
  fileURLToPath(new URL(`../scenarios/${name}`, import.meta.url));

describe('loadScenarioFile', () => {
  it('loads the real AAB-001 scenario', () => {
    const s = loadScenarioFile(realScenario('AAB-001.yaml'));
    expect(s.id).toBe('AAB-001');
    expect(s.schema_version).toBe('0.1');
    expect(s.source.primary_url).toMatch(/^https:\/\//);
    expect(s.forbidden_effect.detector).toBe('canary_mcp_tool');
  });

  it('throws a useful ScenarioValidationError on a schema violation (missing primary_url)', () => {
    const bad = fileURLToPath(
      new URL('./fixtures/scenarios/schema/AAB-904.yaml', import.meta.url),
    );
    let caught: unknown;
    try {
      loadScenarioFile(bad);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScenarioValidationError);
    const e = caught as ScenarioValidationError;
    expect(e.errors.join('\n')).toMatch(/primary_url/);
    expect(e.errors.some((m) => /required/.test(m))).toBe(true);
  });

  it('enforces ajv "uri" and "date" formats (not silently ignored)', () => {
    const bad = fileURLToPath(
      new URL('./fixtures/scenarios/format/AAB-906.yaml', import.meta.url),
    );
    let caught: unknown;
    try {
      loadScenarioFile(bad);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScenarioValidationError);
    const msg = (caught as ScenarioValidationError).errors.join('\n');
    expect(msg).toMatch(/format "uri"/);
    expect(msg).toMatch(/format "date"/);
  });
});

describe('loadScenarioDir', () => {
  it('loads a valid dir and defaults absent headless_fidelity to "full"', () => {
    const { scenarios, errors } = loadScenarioDir(fixtureDir('valid'));
    expect(errors).toEqual([]);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].id).toBe('AAB-900');
    expect(scenarios[0].headless_fidelity).toBe('full');
  });

  it('reports an id/filename-stem mismatch without throwing', () => {
    const { scenarios, errors } = loadScenarioDir(fixtureDir('badid'));
    expect(scenarios).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toBe('AAB-901.yaml');
    expect(errors[0].message).toMatch(/does not match filename stem/);
  });

  it('reports a browser-track scenario that is runnable:true', () => {
    const { scenarios, errors } = loadScenarioDir(fixtureDir('browser'));
    expect(scenarios).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/runnable:false/);
  });

  it('rejects a browser-track scenario with runnable omitted (schema default is true)', () => {
    const { scenarios, errors } = loadScenarioDir(fixtureDir('browser-default'));
    expect(scenarios).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toBe('AAB-905.yaml');
    expect(errors[0].message).toMatch(/runnable:false/);
  });

  it('reports duplicate ids across files', () => {
    const { scenarios, errors } = loadScenarioDir(fixtureDir('dup'));
    expect(scenarios).toHaveLength(0);
    const dupErrors = errors.filter((e) => /duplicate id AAB-903/.test(e.message));
    expect(dupErrors.length).toBeGreaterThanOrEqual(2);
  });
});
