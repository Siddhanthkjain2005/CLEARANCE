// A deployment must name its billing project and source mode explicitly; a
// generic CLI default must never silently become the hackathon deployment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudRunPlan } from '../scripts/deploy-cloud-run.ts';
import { readFileSync } from 'node:fs';

test('cloud preview requires an explicit valid target and live GitLab binding', () => {
  for (const project of ['', 'UPPERCASE', 'a;b', 'https://example.com']) assert.throws(() => cloudRunPlan({ project, simulated: true }));
  assert.throws(() => cloudRunPlan({ project: 'clearance-demo-2026' }));
  assert.throws(() => cloudRunPlan({ project: 'clearance-demo-2026', simulated: true, region: '--other-flag' }));
});

test('live plan uses Secret Manager references and bounded explicit project flags', () => {
  const plan = cloudRunPlan({ project: 'clearance-demo-2026', gitlabProject: 'hackathon/team/clearance' });
  assert.equal(plan.mode, 'live');
  assert.equal(plan.maxInstances, 2);
  const deploy = plan.commands[0];
  assert.ok(deploy.includes('CLEARANCE_MODE=live,CLEARANCE_REGION=northamerica-northeast1,CLEARANCE_PROJECT=hackathon/team/clearance'));
  assert.ok(deploy.includes('--set-secrets'));
  assert.ok(deploy.includes('CLEARANCE_GITLAB_TOKEN=clearance-gitlab-token:latest,CLEARANCE_WEBHOOK_SECRET=clearance-webhook-secret:latest,CLEARANCE_TOWER_TOKEN=clearance-tower-token:latest'));
  for (const command of plan.commands) assert.equal(command[command.indexOf('--project') + 1], 'clearance-demo-2026');
  const simulated = cloudRunPlan({ project: 'clearance-demo-2026', simulated: true });
  assert.equal(simulated.mode, 'simulated');
  assert.ok(!simulated.commands[0].includes('--set-secrets'));
  const infrastructure = readFileSync(new URL('../infra/terraform/main.tf', import.meta.url), 'utf8');
  for (const name of ['clearance-gitlab-token', 'clearance-webhook-secret', 'clearance-tower-token']) assert.ok(infrastructure.includes(`"${name}"`), 'preview bindings match the shipped infrastructure');
  assert.match(infrastructure, /account_id\s*=\s*"clearance-tower"/);
});
