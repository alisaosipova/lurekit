// Per-scenario fixture parameters (ADR-0002 "Interface notes - fixture params"). A scenario's
// `fixtures[].params` (a free object in the scenario schema) reaches the fixture constructor via
// buildFixture(); each fixture validates it with a strict zod schema, so an unknown key or value
// fails loudly at build time instead of being ignored. The runner builds fixtures inside its
// provisioning guard, so a FixtureParamsError becomes inconclusive(fixture_error).

import type { z } from 'zod';

import type { FixtureKind } from '../scenario/types.js';

/** Thrown when a scenario's fixture params do not match the fixture's schema. */
export class FixtureParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureParamsError';
  }
}

/** A short lowercase identifier (skill / MCP server names): ASCII letters, digits, hyphens. */
export const FIXTURE_NAME_RE = /^[a-z][a-z0-9-]{0,47}$/;

/** Validate `params` (undefined => {}) against a fixture's schema; throw FixtureParamsError
 *  naming the fixture kind and every failing path. */
export function parseFixtureParams<S extends z.ZodType>(
  kind: FixtureKind,
  schema: S,
  params: unknown,
): z.output<S> {
  const result = schema.safeParse(params ?? {});
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(params)'}: ${i.message}`)
    .join('; ');
  throw new FixtureParamsError(`fixture "${kind}" has invalid params: ${detail}`);
}
