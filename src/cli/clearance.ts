#!/usr/bin/env node
// Clearance command line: the deterministic half of the post-code lifecycle.
// GitLab CI calls these commands; Duo agents call the Tower's MCP tools.

import { assess, gate } from './commands/assess.ts';
import { fly, land } from './commands/fly.ts';
import { evidence, release, sci } from './commands/govern.ts';
import { budget, coverage, doccheck, explain, ledger, predict } from './commands/misc.ts';

const HELP = `clearance <command> [options]

Pipeline commands
  assess              Score the change, decide clearance, generate the child pipeline
  gate                Re-score with security findings; label, note and auto-merge the MR
  fly [--drill] [--fault errors|latency] [--time-scale n]
                      Progressive delivery with statistical canary analysis
  land                Record the outcome in the trust ledger; open an incident on go-around
  release             Cut a semantic-versioned release for a landed flight
  evidence            Build the tamper-evident evidence pack (black box)
  sci                 Software Carbon Intensity for this flight

Utilities
  explain             Show what the governor would decide for the local diff
  predict --files p:a:d[,...] [--pilot name] [--json]
                      Predict the clearance of a planned change (used by Duo agents)
  ledger              Print the trust ledger
  doccheck            Verify relative links in markdown
  budget <dir>        Enforce the gzipped bundle budget
  coverage <lcov>     Summarise line coverage from an lcov file
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'assess': return assess();
    case 'gate': return gate();
    case 'fly': {
      const fault = flag(args, '--fault');
      return fly({
        drill: args.includes('--drill'),
        fault: fault === 'errors' || fault === 'latency' ? fault : null,
        timeScale: flag(args, '--time-scale') ? Number(flag(args, '--time-scale')) : undefined,
        rps: flag(args, '--rps') ? Number(flag(args, '--rps')) : undefined,
      });
    }
    case 'land': return land();
    case 'release': return release();
    case 'evidence': return evidence();
    case 'sci': return sci();
    case 'explain': return explain();
    case 'predict': return predict(args);
    case 'ledger': return ledger();
    case 'doccheck': return doccheck();
    case 'budget': return budget(args[0] ?? 'dist/web');
    case 'coverage': return coverage(args[0] ?? 'lcov.info');
    case undefined:
    case 'help':
    case '--help':
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(`unknown command "${cmd}"\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(`clearance: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
