// Progressive delivery targets.
//
// CloudRunDeployer drives Google Cloud Run with gcloud: deploy a tagged,
// zero-traffic canary revision, shift traffic in steps, then promote or roll
// back. Authentication comes from GitLab's Google Cloud IAM integration
// (workload identity federation, `identity: google_cloud` on the job), so no
// long-lived keys are stored in CI variables.
//
// DrillDeployer is an in-process stand-in used for local runs and tests. It
// serves synthetic traffic with optional fault injection so the full
// fly → analyse → land loop can be exercised without a cloud account.

import { execFileSync } from 'node:child_process';
import { lognormalSample, rng } from '../core/stats.ts';

export interface RevisionTraffic {
  revision: string;
  percent: number;
  tag?: string;
}

export interface Deployer {
  readonly name: string;
  describe(): Promise<{ url: string | null; traffic: RevisionTraffic[] }>;
  deployCanary(image: string, envVars: Record<string, string>): Promise<{ revision: string; url: string }>;
  setTraffic(stable: string | null, canary: string, canaryPercent: number): Promise<void>;
  promote(canary: string): Promise<void>;
  rollback(stable: string | null, canary: string): Promise<void>;
  /** Sends one request to the service and reports which revision answered. */
  probe(url: string): Promise<{ revision: string; ok: boolean; ms: number }>;
}

export class CloudRunDeployer implements Deployer {
  readonly name = 'cloud-run';
  private service: string;
  private region: string;
  private project: string | undefined;
  constructor(service: string, region: string, project?: string) {
    this.service = service;
    this.region = region;
    this.project = project;
  }

  private gcloud(args: string[]): string {
    const full = [...args, `--region=${this.region}`, '--quiet'];
    if (this.project) full.push(`--project=${this.project}`);
    return execFileSync('gcloud', full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024 });
  }

  async describe() {
    try {
      const svc = JSON.parse(this.gcloud(['run', 'services', 'describe', this.service, '--format=json']));
      const traffic: RevisionTraffic[] = (svc.status?.traffic ?? [])
        .filter((t: { revisionName?: string }) => t.revisionName)
        .map((t: { revisionName: string; percent?: number; tag?: string }) => ({ revision: t.revisionName, percent: t.percent ?? 0, tag: t.tag }));
      return { url: svc.status?.url ?? null, traffic };
    } catch {
      return { url: null, traffic: [] }; // first deployment: the service does not exist yet
    }
  }

  async deployCanary(image: string, envVars: Record<string, string>) {
    const existing = await this.describe();
    const envArg = Object.entries(envVars).map(([k, v]) => `${k}=${v}`).join(',');
    // --update keeps secrets and settings from earlier revisions; a drill flag never outlives its canary.
    const args = ['run', 'deploy', this.service, `--image=${image}`, `--update-env-vars=${envArg}`, '--format=json'];
    if (!('CLEARANCE_DRILL' in envVars)) args.push('--remove-env-vars=CLEARANCE_DRILL');
    if (existing.url) args.push('--no-traffic', '--tag=canary');
    else args.push('--allow-unauthenticated');
    const svc = JSON.parse(this.gcloud(args));
    return { revision: svc.status?.latestCreatedRevisionName as string, url: svc.status?.url as string };
  }

  async setTraffic(stable: string | null, canary: string, canaryPercent: number) {
    if (!stable || canaryPercent >= 100) {
      this.gcloud(['run', 'services', 'update-traffic', this.service, `--to-revisions=${canary}=100`]);
      return;
    }
    this.gcloud(['run', 'services', 'update-traffic', this.service, `--to-revisions=${stable}=${100 - canaryPercent},${canary}=${canaryPercent}`]);
  }

  async promote(canary: string) {
    this.gcloud(['run', 'services', 'update-traffic', this.service, `--to-revisions=${canary}=100`]);
    this.gcloud(['run', 'services', 'update-traffic', this.service, `--update-tags=stable=${canary}`, '--remove-tags=canary']);
  }

  async rollback(stable: string | null, canary: string) {
    if (stable) this.gcloud(['run', 'services', 'update-traffic', this.service, `--to-revisions=${stable}=100`, '--remove-tags=canary']);
    else this.gcloud(['run', 'services', 'update-traffic', this.service, `--to-revisions=${canary}=0`]);
  }

  async probe(url: string) {
    const t0 = performance.now();
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/api/probe`, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'clearance-canary' } });
      await res.arrayBuffer();
      return { revision: res.headers.get('x-clearance-revision') ?? 'unknown', ok: res.status < 500, ms: performance.now() - t0 };
    } catch {
      return { revision: 'unknown', ok: false, ms: performance.now() - t0 };
    }
  }
}

/** Simulated target with deterministic traffic and optional fault injection. */
export class DrillDeployer implements Deployer {
  readonly name = 'drill';
  private split = 0;
  private canaryRev = '';
  private stableRev = 'tower-00041-stable';
  private rand: () => number;
  private fault: { errorRate: number; latencyFactor: number };
  constructor(seed = 42, fault: { errorRate?: number; latencyFactor?: number } = {}) {
    this.rand = rng(seed);
    this.fault = { errorRate: fault.errorRate ?? 0, latencyFactor: fault.latencyFactor ?? 1 };
  }
  async describe() {
    return { url: 'https://drill.local', traffic: [{ revision: this.stableRev, percent: 100 - this.split, tag: 'stable' }] };
  }
  async deployCanary() {
    this.canaryRev = 'tower-00042-canary';
    return { revision: this.canaryRev, url: 'https://drill.local' };
  }
  async setTraffic(_s: string | null, _c: string, pct: number) { this.split = pct; }
  async promote() { this.split = 100; }
  async rollback() { this.split = 0; }
  async probe() {
    const canary = this.rand() * 100 < this.split;
    const errRate = canary ? 0.002 + this.fault.errorRate : 0.002;
    const median = canary ? 38 * this.fault.latencyFactor : 38;
    return { revision: canary ? this.canaryRev : this.stableRev, ok: this.rand() >= errRate, ms: lognormalSample(this.rand, median, 0.3) };
  }
}
