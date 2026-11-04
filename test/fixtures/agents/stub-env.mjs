#!/usr/bin/env node
// Offline env-recording stub for test/child-env.test.ts (ADR-0008 amendment "Child env
// allow-list"). It never touches the network. `--version` prints a fixed version. Otherwise it
// records the NAMES of its environment (never the values) and exits 0.
// Env knobs:
//   AAB_STUB_ENV_NAMES_OUT  file to write {"names": [...sorted env names]} into
//   AAB_STUB_STDERR_BYTES   write this many bytes of 'e' to stderr before exiting
import fs from 'node:fs';

if (process.argv.includes('--version')) {
  process.stdout.write('0.0.0-stub\n');
  process.exit(0);
}
const out = process.env.AAB_STUB_ENV_NAMES_OUT;
if (out) fs.writeFileSync(out, JSON.stringify({ names: Object.keys(process.env).sort() }), 'utf8');
const n = Number(process.env.AAB_STUB_STDERR_BYTES ?? 0);
if (n > 0) {
  const chunk = Buffer.alloc(64 * 1024, 'e');
  let left = n;
  const writeMore = () => {
    while (left > 0) {
      const part = left >= chunk.length ? chunk : chunk.subarray(0, left);
      left -= part.length;
      if (!process.stderr.write(part)) {
        process.stderr.once('drain', writeMore);
        return;
      }
    }
  };
  writeMore();
}
