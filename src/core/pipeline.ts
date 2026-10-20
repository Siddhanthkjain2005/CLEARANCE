// Risk-adaptive pipelines.
//
// The governor's tier decides which verification jobs a flight needs. The
// parent .gitlab-ci.yml triggers the generated YAML as a dynamic child
// pipeline. Security scanning never adapts: it runs on every flight in the
// parent pipeline. Only the expensive *verification depth* scales with risk,
// and every job that a fixed pipeline would have run but this one skipped is
// recorded as avoided energy in the SCI report.

import { stringifyYaml, type YamlValue } from './yaml.ts';
import type { JobFootprintInput } from './sci.ts';
import type { PipelineTier } from './types.ts';
import type { ImpactResult } from './impact.ts';

export interface CatalogJob {
  name: string;
  purpose: string;
  tiers: PipelineTier[];
  typicalSec: number; // used for the SCI baseline when the job is skipped
  runner: string;
  script: (ctx: GenerateContext) => string[];
  artifacts?: YamlValue;
}

export interface GenerateContext {
  tier: PipelineTier;
  impact: ImpactResult;
  webChanged: boolean;
}

const SETUP = ['[ -f package-lock.json ] && npm ci --no-audit --no-fund || npm install --no-audit --no-fund'];

export const JOB_CATALOG: CatalogJob[] = [
  {
    name: 'docs:links',
    purpose: 'Check that every relative link in the docs resolves',
    tiers: ['taxi', 'lean', 'standard', 'full'],
    typicalSec: 20,
    runner: 'saas-linux-small-amd64',
    script: () => ['node src/cli/clearance.ts doccheck'],
  },
  {
    name: 'test:impacted',
    purpose: 'Run only the tests that can observe the change',
    tiers: ['lean'],
    typicalSec: 35,
    runner: 'saas-linux-small-amd64',
    script: (ctx) =>
      ctx.impact.mode === 'impacted'
        ? [`node --test --experimental-test-coverage --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=junit.xml ${ctx.impact.tests.join(' ')}`]
        : ctx.impact.mode === 'all'
          ? ['node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=junit.xml "test/*.test.ts"']
          : ['echo "No test observes the changed modules"'],
    artifacts: { when: 'always', reports: { junit: 'junit.xml' } },
  },
  {
    name: 'test:unit',
    purpose: 'Run the full unit test suite with coverage',
    tiers: ['standard', 'full'],
    typicalSec: 70,
    runner: 'saas-linux-small-amd64',
    script: () => [
      'node --test --experimental-test-coverage --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=junit.xml --test-reporter=lcov --test-reporter-destination=lcov.info "test/*.test.ts"',
      'node src/cli/clearance.ts coverage lcov.info',
    ],
    artifacts: { when: 'always', reports: { junit: 'junit.xml' }, paths: ['lcov.info'] },
  },
  {
    name: 'typecheck',
    purpose: 'Type-check the whole codebase',
    tiers: ['standard', 'full'],
    typicalSec: 55,
    runner: 'saas-linux-small-amd64',
    script: () => [...SETUP, 'npx tsc --noEmit -p tsconfig.json'],
  },
  {
    name: 'build:web',
    purpose: 'Bundle the console and enforce the size budget',
    tiers: ['lean', 'standard', 'full'],
    typicalSec: 40,
    runner: 'saas-linux-small-amd64',
    script: () => [...SETUP, 'npm run build:web', 'node src/cli/clearance.ts budget dist/web'],
    artifacts: { paths: ['dist/web/'], expire_in: '1 day' },
  },
  {
    name: 'test:smoke',
    purpose: 'Boot the Tower and probe every public endpoint',
    tiers: ['standard', 'full'],
    typicalSec: 50,
    runner: 'saas-linux-small-amd64',
    script: () => ['node test/smoke.ts'],
  },
  {
    name: 'test:soak',
    purpose: 'Sustained load against the Tower to catch leaks and latency drift',
    tiers: ['full'],
    typicalSec: 150,
    runner: 'saas-linux-small-amd64',
    script: () => ['node test/soak.ts --seconds 120'],
  },
];

export function plannedJobs(tier: PipelineTier, ctx: Omit<GenerateContext, 'tier'>): CatalogJob[] {
  return JOB_CATALOG.filter((j) => j.tiers.includes(tier)).filter((j) => {
    if (j.name === 'build:web' && tier === 'lean' && !ctx.webChanged) return false;
    if (j.name === 'test:impacted' && ctx.impact.mode === 'none') return false;
    return true;
  });
}

/** Jobs a fixed, always-full pipeline would run that this tier skips. */
export function avoidedJobs(tier: PipelineTier, ctx: Omit<GenerateContext, 'tier'>): JobFootprintInput[] {
  const planned = new Set(plannedJobs(tier, ctx).map((j) => j.name));
  return plannedJobs('full', { ...ctx, impact: { mode: 'all', tests: [], reason: '' }, webChanged: true })
    .filter((j) => !planned.has(j.name))
    .map((j) => ({ name: j.name, durationSec: j.typicalSec, runner: j.runner, status: 'avoided' as const }));
}

export function generateChildPipeline(ctx: GenerateContext): string {
  const jobs = plannedJobs(ctx.tier, ctx);
  const doc: { [k: string]: YamlValue } = {
    default: {
      image: 'node:22', // includes git, which the end-to-end test drives
      interruptible: true,
      cache: { key: { files: ['package.json'] }, paths: ['.npm/'], policy: 'pull-push' },
    },
    variables: { npm_config_cache: '$CI_PROJECT_DIR/.npm', CLEARANCE_TIER: ctx.tier },
    stages: ['verify'],
  };
  for (const j of jobs) {
    const job: { [k: string]: YamlValue } = {
      stage: 'verify',
      script: j.script(ctx),
    };
    if (j.artifacts) job.artifacts = j.artifacts;
    doc[j.name] = job;
  }
  const header =
    `# Generated by Clearance for a "${ctx.tier}" flight. Do not edit.\n` +
    `# ${jobs.length} verification job(s); impact analysis: ${ctx.impact.reason || ctx.impact.mode}\n`;
  return header + stringifyYaml(doc);
}
