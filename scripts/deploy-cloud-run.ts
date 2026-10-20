// Make deployment explicit and reviewable: never use the machine's unrelated
// default project. The default prints an argv plan; only --apply invokes gcloud.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export interface CloudTarget {
  project: string;
  gitlabProject?: string;
  region?: string;
  simulated?: boolean;
}

export function cloudRunPlan(target: CloudTarget) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(target.project)) throw new Error('Pass an explicit Google Cloud project ID with --project');
  const region = target.region ?? 'northamerica-northeast1';
  if (!/^[a-z]+-[a-z]+\d+$/.test(region)) throw new Error('Pass a valid Google Cloud region');
  if (!target.simulated && !/^[\w.-]+(?:\/[\w.-]+)+$/.test(target.gitlabProject ?? '')) throw new Error('Live deployment requires --gitlab-project <group>/<project>; use --simulated only for a labelled preview');
  const service = 'clearance-tower';
  const environment = [`CLEARANCE_MODE=${target.simulated ? 'simulated' : 'live'}`, `CLEARANCE_REGION=${region}`];
  if (!target.simulated) environment.push(`CLEARANCE_PROJECT=${target.gitlabProject}`);
  const deploy = [
    'run', 'deploy', service, '--source', '.', '--project', target.project,
    '--region', region, '--allow-unauthenticated', '--cpu', '1', '--memory', '512Mi',
    '--min-instances', '0', '--max-instances', '2', '--timeout', '3600',
    '--set-env-vars', environment.join(','),
  ];
  if (!target.simulated) deploy.push(
    '--service-account', `${service}@${target.project}.iam.gserviceaccount.com`,
    '--set-secrets', 'CLEARANCE_GITLAB_TOKEN=clearance-gitlab-token:latest,CLEARANCE_WEBHOOK_SECRET=clearance-webhook-secret:latest,CLEARANCE_TOWER_TOKEN=clearance-tower-token:latest',
  );
  return {
    project: target.project, region, mode: target.simulated ? 'simulated' : 'live',
    publicService: true, maxInstances: 2,
    prerequisites: target.simulated ? ['Billing and required service APIs enabled'] : [
      'Billing and required service APIs enabled',
      `${service} service account exists`,
      'The three named Secret Manager secrets exist and the runtime account can access them',
      'The GitLab read token can access the configured project',
    ],
    commands: [deploy, ['run', 'services', 'describe', service, '--project', target.project, '--region', region, '--format=value(status.url)']],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const value = (flag: string) => { const at = process.argv.indexOf(flag); return at >= 0 ? process.argv[at + 1] : undefined; };
  try {
    const plan = cloudRunPlan({ project: value('--project') ?? '', gitlabProject: value('--gitlab-project'), region: value('--region'), simulated: process.argv.includes('--simulated') });
    if (!process.argv.includes('--apply')) console.log(JSON.stringify({ dryRun: true, ...plan }, null, 2));
    else {
      for (const args of plan.commands) {
        const result = spawnSync('gcloud', args, { stdio: 'inherit' });
        if (result.error) throw new Error(result.error.message);
        if (result.status !== 0) throw new Error(`gcloud failed with status ${result.status}; deployment is not confirmed`);
      }
      console.log('Check /api/health and /api/state at the printed URL before recording a successful deployment.');
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
