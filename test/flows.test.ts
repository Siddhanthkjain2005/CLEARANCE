// Lints the Duo custom flow definitions against the flow registry v1 rules
// that GitLab enforces, so a broken flow is caught in CI rather than in the UI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { parseYaml } from '../src/core/yaml.ts';

type Obj = Record<string, any>;
const dir = new URL('../.gitlab/duo/flows/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.yml'));

test('there are flow definitions to lint', () => {
  assert.ok(files.length >= 3);
});

for (const file of files) {
  test(`flow ${file} follows the v1 schema`, () => {
    const flow = parseYaml(readFileSync(new URL(file, dir), 'utf8')) as Obj;
    assert.equal(flow.version, 'v1');
    assert.equal(flow.environment, 'ambient', 'custom flows only support the ambient environment');
    for (const banned of ['name', 'description', 'product_group']) assert.ok(!(banned in flow), `top-level ${banned} is rejected`);
    if ('coding_environment' in flow) assert.ok(['full', 'none'].includes(flow.coding_environment));

    const components = flow.components as Obj[];
    const names = new Set(components.map((c) => c.name));
    const prompts = new Map((flow.prompts as Obj[]).map((p) => [p.prompt_id, p]));
    for (const c of components) {
      assert.match(c.name, /^[A-Za-z0-9_-]+$/, `component name ${c.name} must not contain : or .`);
      assert.ok(['AgentComponent', 'OneOffComponent', 'DeterministicStepComponent', 'HumanInputComponent'].includes(c.type));
      assert.ok(!('response_schema_id' in c), 'response schemas are not supported in custom flows');
      const p = prompts.get(c.prompt_id);
      assert.ok(p, `prompt ${c.prompt_id} is defined`);
      assert.ok(!('model' in p), 'prompt model is not supported in custom flows');
      assert.deepEqual(p.unit_primitives, []);
      assert.equal(p.prompt_template.placeholder, 'history');
      assert.match(p.prompt_template.system, /Stop after/i, 'system prompts end with a stopping condition');
      // every template variable must be provided by an input alias
      const aliases = new Set((c.inputs as (Obj | string)[]).map((i) => (typeof i === 'string' ? i.split(':').pop() : i.as)));
      const used = [...`${p.prompt_template.system}\n${p.prompt_template.user}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
      for (const u of used) assert.ok(aliases.has(u), `${c.name}: template variable {{${u}}} has no input`);
      // inputs that read other components must reference earlier components
      for (const i of c.inputs as (Obj | string)[]) {
        const from = typeof i === 'string' ? i : i.from;
        const m = /^context:([\w-]+)\.final_answer$/.exec(from);
        if (m) assert.ok(names.has(m[1]), `${c.name} reads unknown component ${m[1]}`);
      }
      assert.ok(Array.isArray(c.toolset) && c.toolset.length > 0);
      if ((c.toolset as unknown[]).some((t) => typeof t === 'string' && /^(create_commit|create_merge_request)$/.test(t))) {
        assert.match(p.prompt_template.system, /Clearance-Pilot|create_merge_request/, 'writing agents identify themselves');
      }
    }

    const targets = new Set([...names, 'end', 'abort']);
    for (const r of flow.routers as Obj[]) {
      assert.ok(names.has(r.from), `router from ${r.from}`);
      if (r.condition) {
        assert.ok('default_route' in r.condition.routes, 'conditional routers need a default_route');
        for (const t of Object.values(r.condition.routes)) assert.ok(targets.has(t as string), `route to ${t}`);
      } else assert.ok(targets.has(r.to), `route to ${r.to}`);
    }
    assert.ok(names.has(flow.flow.entry_point));
    // every component is reachable from the entry point
    const reach = new Set([flow.flow.entry_point]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of flow.routers as Obj[]) {
        if (!reach.has(r.from)) continue;
        const outs = r.condition ? Object.values(r.condition.routes) : [r.to];
        for (const o of outs as string[]) if (names.has(o) && !reach.has(o)) { reach.add(o); grew = true; }
      }
    }
    for (const n of names) assert.ok(reach.has(n), `${n} is reachable`);
  });
}

test('agents are told never to touch governance files', () => {
  for (const file of files) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    if (/create_commit/.test(text)) assert.match(text, /\.clearance\//, `${file} names the protected governance paths`);
  }
});
