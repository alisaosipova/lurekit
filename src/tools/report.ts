#!/usr/bin/env node
// CLI: render a scoring report from a completed benchmark run directory (evidence-spec §6).
// Reads <runDir>/manifest.json, builds the scoring block, and prints the chosen --format to
// stdout or to --output. The reporter itself is pure; this CLI does the only I/O — reading the
// manifest and, for Markdown, the per-vulnerable evidence.json excerpt via an injected lookup.
// It never phones home or posts anywhere (§6.3).
//
// Usage: report <runDir> [--format json|markdown|sarif] [--output <file>]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import type { EvidenceRecord, RunManifest } from '../runner/types.js';
import { report, type ReportFormat } from '../report/index.js';

const FORMATS: ReportFormat[] = ['json', 'markdown', 'sarif'];

interface Args {
  runDir: string;
  format: ReportFormat;
  output?: string;
}

function parseArgs(argv: string[]): Args {
  let runDir: string | undefined;
  let format: ReportFormat = 'json';
  let output: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format' || a === '-f') {
      const v = argv[++i];
      if (!FORMATS.includes(v as ReportFormat)) {
        throw new Error(`--format must be one of ${FORMATS.join('|')} (got "${v ?? ''}")`);
      }
      format = v as ReportFormat;
    } else if (a === '--output' || a === '-o') {
      output = argv[++i];
    } else if (!a.startsWith('-') && runDir === undefined) {
      runDir = a;
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  if (!runDir) throw new Error('a benchmark run directory is required');
  return { runDir, format, output };
}

/** Load the evidence.json that best represents a scenario: the first repetition whose outcome
 *  is vulnerable (that is the hit the excerpt should show), else repetition 0. Returns undefined
 *  if nothing is on disk. The run-dir layout is <runDir>/<scenario_id>/<k>/evidence.json (§2.1). */
function loadEvidence(runDir: string, scenarioId: string, reps: number): EvidenceRecord | undefined {
  const read = (rep: number): EvidenceRecord | undefined => {
    const p = path.join(runDir, scenarioId, String(rep), 'evidence.json');
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as EvidenceRecord;
    } catch {
      return undefined;
    }
  };
  for (let rep = 0; rep < Math.max(1, reps); rep++) {
    const ev = read(rep);
    if (ev && ev.outcome === 'vulnerable') return ev;
  }
  return read(0);
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(args.runDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    process.stderr.write(`no manifest.json in ${args.runDir}\n`);
    return 1;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RunManifest;

  const runsById = new Map(manifest.results.map((r) => [r.scenario_id, r.runs]));
  const out = report(manifest, {
    format: args.format,
    evidenceLookup: (scenarioId) =>
      loadEvidence(args.runDir, scenarioId, runsById.get(scenarioId) ?? 1),
  });

  if (args.output) {
    writeFileSync(args.output, out, 'utf8');
  } else {
    process.stdout.write(out);
  }
  return 0;
}

process.exit(main());
