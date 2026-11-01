#!/usr/bin/env node
// CLI: validate every scenario in a directory (default "scenarios").
// Prints one line per loaded scenario (id + name + OK), all errors to stderr,
// exits 0 when everything is valid, 1 otherwise. Backs the "validate:scenarios" script.

import { loadScenarioDir } from '../scenario/load.js';

function main(): number {
  const dir = process.argv[2] ?? 'scenarios';
  const { scenarios, errors } = loadScenarioDir(dir);

  for (const s of scenarios) {
    process.stdout.write(`OK    ${s.id}  ${s.name}\n`);
  }

  for (const e of errors) {
    process.stderr.write(`FAIL  ${e.file}  ${e.message}\n`);
  }

  process.stdout.write(
    `\n${scenarios.length} valid, ${errors.length} error${errors.length === 1 ? '' : 's'} in ${dir}\n`,
  );

  return errors.length === 0 ? 0 : 1;
}

process.exit(main());
