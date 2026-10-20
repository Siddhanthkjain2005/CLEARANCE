// Prepare optional GitLab integration settings. The default is a dry
// run; --apply writes only the displayed settings, intent label and webhook.
// Tokens come from environment variables and never appear in the plan/output.

import { pathToFileURL } from 'node:url';
import { GitLab, GitLabError } from '../src/core/gitlab.ts';

export interface SetupOptions {
  project: string;
  public: boolean;
  towerUrl?: string;
}

export function setupPlan(options: SetupOptions) {
  if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(options.project)) throw new Error('Pass a full GitLab project path, without a URL or credentials');
  if (options.towerUrl) {
    const url = new URL(options.towerUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Tower URL must be public HTTPS without credentials, query or fragment');
  }
  return {
    project: options.project,
    settings: { only_allow_merge_if_pipeline_succeeds: true, remove_source_branch_after_merge: true, ...(options.public ? { visibility: 'public' } : {}) },
    label: { name: 'intent', color: '#20896b', description: 'An intent for the Clearance Dispatch flow' },
    webhook: options.towerUrl ? new URL('/webhooks/gitlab', options.towerUrl).href : null,
    manual: [
      'Review and add the CI variables from docs/setup.md; never commit token values',
      'Enable Dispatch, Medic and Debrief in Automate > Agents and configure their triggers',
      'Have the owner review CODEOWNERS, the MCP endpoint and protected-branch merge permissions',
      'Run a real intent and retain its Duo session, MR, pipeline and release URLs',
    ],
  };
}

export async function configureProject(client: GitLab, options: SetupOptions, webhookSecret?: string) {
  const plan = setupPlan(options);
  if (plan.webhook && !webhookSecret) throw new Error('CLEARANCE_WEBHOOK_SECRET is required when configuring a webhook');
  const path = `/projects/${encodeURIComponent(options.project)}`;
  const project = await client.get<{ id: number; path_with_namespace: string; web_url: string }>(path);
  if (project.path_with_namespace !== options.project) throw new Error('GitLab returned a different project; no settings were changed');
  await client.request('PUT', path, plan.settings);
  const labels = await client.paginate<{ name: string }>(`${path}/labels`);
  if (!labels.some((label) => label.name === 'intent')) await client.request('POST', `${path}/labels`, plan.label);
  if (plan.webhook) {
    const hooks = await client.get<{ id: number; url: string }[]>(`${path}/hooks`);
    const existing = hooks.find((hook) => hook.url === plan.webhook);
    const body = {
      url: plan.webhook, token: webhookSecret,
      pipeline_events: true, job_events: true, merge_requests_events: true,
      issues_events: true, note_events: true, releases_events: true,
      deployment_events: true, enable_ssl_verification: true,
    };
    await client.request(existing ? 'PUT' : 'POST', `${path}/hooks${existing ? `/${existing.id}` : ''}`, body);
  }
  return { project: project.web_url, configured: true, webhookConfigured: !!plan.webhook, manual: plan.manual };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const value = (flag: string) => { const at = process.argv.indexOf(flag); return at >= 0 ? process.argv[at + 1] : undefined; };
  try {
    const options = { project: value('--project') ?? process.env.CLEARANCE_PROJECT ?? '', public: process.argv.includes('--public'), towerUrl: value('--tower') };
    const plan = setupPlan(options);
    if (!process.argv.includes('--apply')) console.log(JSON.stringify({ dryRun: true, ...plan }, null, 2));
    else {
      const token = process.env.CLEARANCE_TOKEN;
      if (!token) throw new Error('Sign in and provide CLEARANCE_TOKEN through your terminal environment; do not paste it in chat');
      const client = new GitLab({ baseUrl: `${(process.env.CLEARANCE_GITLAB_URL ?? 'https://gitlab.com').replace(/\/$/, '')}/api/v4`, token });
      console.log(JSON.stringify(await configureProject(client, options, process.env.CLEARANCE_WEBHOOK_SECRET), null, 2));
    }
  } catch (error) {
    console.error(error instanceof GitLabError ? `GitLab ${error.status} on ${error.path}; check project permissions` : (error as Error).message);
    process.exitCode = 1;
  }
}
