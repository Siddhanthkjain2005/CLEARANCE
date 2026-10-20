// Check target validation and repeatable setup before any real project is
// configured. The fake transport records mutations without using credentials.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitLab } from '../src/core/gitlab.ts';
import { configureProject, setupPlan } from '../scripts/gitlab-setup.ts';

test('setup preview requires an explicit project and refuses credential-bearing URLs', () => {
  for (const project of ['', 'clearance', 'https://gitlab.com/a/b', 'a/b?token=x']) assert.throws(() => setupPlan({ project, public: false }));
  for (const towerUrl of ['http://demo.example', 'https://user:password@demo.example', 'https://demo.example/?token=x']) assert.throws(() => setupPlan({ project: 'group/clearance', public: true, towerUrl }));
  const plan = setupPlan({ project: 'group/clearance', public: true, towerUrl: 'https://tower.example' });
  assert.equal(plan.webhook, 'https://tower.example/webhooks/gitlab');
  assert.equal(plan.settings.only_allow_merge_if_pipeline_succeeds, true);
  assert.ok(!JSON.stringify(plan).includes('PRIVATE-TOKEN'));
});

test('repeated project setup updates one webhook and preserves existing labels', async () => {
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const labels = [{ name: 'existing' }];
  const hooks: { id: number; url: string }[] = [];
  const client = new GitLab({ baseUrl: 'https://gitlab.example/api/v4', token: 'test-only', fetchImpl: async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    let result: unknown;
    if (method === 'GET') {
      result = path.endsWith('/labels') ? labels : path.endsWith('/hooks') ? hooks : { id: 42, path_with_namespace: 'group/clearance', web_url: 'https://gitlab.example/group/clearance' };
    } else {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      writes.push({ method, path, body });
      if (path.endsWith('/labels')) labels.push({ name: String(body.name) });
      if (path.endsWith('/hooks')) hooks.push({ id: 1, url: String(body.url) });
      result = {};
    }
    return new Response(JSON.stringify(result), { status: 200 });
  } });
  const options = { project: 'group/clearance', public: true, towerUrl: 'https://tower.example' };
  await configureProject(client, options, 'test-hook-secret');
  await configureProject(client, options, 'test-hook-secret');
  assert.deepEqual(labels.map((label) => label.name), ['existing', 'intent']);
  assert.equal(writes.filter((call) => call.method === 'POST' && call.path.endsWith('/hooks')).length, 1);
  assert.equal(writes.filter((call) => call.method === 'PUT' && call.path.endsWith('/hooks/1')).length, 1);
  assert.ok(writes.filter((call) => call.path.includes('/hooks')).every((call) => call.body.enable_ssl_verification === true));
});
