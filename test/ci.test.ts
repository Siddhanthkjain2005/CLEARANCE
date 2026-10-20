// Lints .gitlab-ci.yml and its local includes: every stage, needs and extends
// reference resolves, and every job can be scheduled. GitLab would reject
// these mistakes only after a push; this catches them in the first job.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml } from '../src/core/yaml.ts';

type Obj = Record<string, any>;
const root = new URL('../', import.meta.url);
const main = parseYaml(readFileSync(new URL('.gitlab-ci.yml', root), 'utf8')) as Obj;
const includes = (main.include as Obj[]).filter((i) => i.local).map((i) => parseYaml(readFileSync(new URL(i.local, root), 'utf8')) as Obj);
const all: Obj = Object.assign({}, main, ...includes);
const RESERVED = new Set(['workflow', 'stages', 'variables', 'include', 'default', 'image', 'services', 'cache', 'before_script', 'after_script']);
// Jobs that come from GitLab's security templates.
const TEMPLATE_JOBS = new Set(['semgrep-sast', 'secret_detection', 'container_scanning', 'gemnasium-dependency_scanning', 'sast', 'dependency_scanning']);
const jobs = Object.entries(all).filter(([k]) => !RESERVED.has(k) && !k.startsWith('.'));
const hidden = new Set(Object.keys(all).filter((k) => k.startsWith('.')));
const stages = new Set<string>([...(main.stages as string[]), '.pre', '.post']);

test('local includes are all present', () => {
  assert.ok(includes.length >= 2);
});

test('every job has a known stage and something to run', () => {
  for (const [name, job] of jobs) {
    let stage = job.stage;
    for (const e of [job.extends ?? []].flat()) stage ??= all[e]?.stage;
    if (TEMPLATE_JOBS.has(name)) continue;
    assert.ok(stage, `${name} has a stage`);
    assert.ok(stages.has(stage), `${name}: stage ${stage} is declared`);
    const runs = job.script || job.trigger || [job.extends ?? []].flat().some((e: string) => all[e]?.script);
    assert.ok(runs, `${name} has a script or trigger`);
  }
});

test('extends and !reference targets exist', () => {
  const visit = (v: unknown, where: string) => {
    if (Array.isArray(v)) v.forEach((x) => visit(x, where));
    else if (v && typeof v === 'object') {
      const o = v as Obj;
      if ('!reference' in o) assert.ok(hidden.has(o['!reference'][0]) || o['!reference'][0] in all, `${where}: !reference ${o['!reference'][0]}`);
      for (const [k, x] of Object.entries(o)) visit(x, `${where}.${k}`);
    }
  };
  for (const [name, job] of Object.entries(all)) {
    for (const e of [job?.extends ?? []].flat()) assert.ok(hidden.has(e), `${name} extends ${e}`);
    visit(job, name);
  }
});

test('needs point at jobs that exist or are optional', () => {
  const names = new Set(jobs.map(([n]) => n));
  for (const [name, job] of jobs) {
    for (const n of job.needs ?? []) {
      const target = typeof n === 'string' ? n : n.job;
      const optional = typeof n === 'object' && n.optional === true;
      assert.ok(names.has(target) || (optional && TEMPLATE_JOBS.has(target)) || optional, `${name} needs ${target}`);
    }
  }
});

test('script lines are strings (a stray ": " would turn one into a mapping)', () => {
  for (const [name, job] of Object.entries(all)) {
    for (const key of ['script', 'before_script', 'after_script']) {
      for (const line of [job?.[key] ?? []].flat()) assert.equal(typeof line, 'string', `${name}.${key}: ${JSON.stringify(line).slice(0, 120)}`);
    }
  }
});

test('the child pipeline comes from the assess job artifact', () => {
  const trigger = all['verify:flight'].trigger;
  assert.equal(trigger.include[0].job, 'clearance:assess');
  assert.equal(trigger.include[0].artifact, '.clearance-out/child-pipeline.yml');
  assert.equal(trigger.strategy, 'depend');
});

test('deployments are serialised and governed', () => {
  assert.equal(all['monitor:canary'].resource_group, 'production');
  assert.equal(all['monitor:canary'].environment.name, 'production');
  assert.ok(all['clearance:gate'].rules, 'gate runs only on merge requests');
});
