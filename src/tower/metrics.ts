// Request telemetry for the Tower itself: RED metrics per route, a latency
// histogram, per-minute SLO buckets and process CPU time for runtime SCI.
// Exposed in Prometheus text format at /metrics.

import type { Bucket } from '../core/slo.ts';

const BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

interface RouteStats {
  count: number;
  errors: number;
  sumMs: number;
  hist: number[];
}

export class Metrics {
  readonly revision = process.env.K_REVISION ?? 'local';
  readonly startedAt = Date.now();
  private routes = new Map<string, RouteStats>();
  private buckets: Bucket[] = [];
  private cpuStart = process.cpuUsage();
  requests = 0;

  observe(route: string, status: number, ms: number) {
    this.requests++;
    let r = this.routes.get(route);
    if (!r) this.routes.set(route, (r = { count: 0, errors: 0, sumMs: 0, hist: new Array(BOUNDS.length + 1).fill(0) }));
    r.count++;
    r.sumMs += ms;
    if (status >= 500) r.errors++;
    let i = BOUNDS.findIndex((b) => ms <= b);
    if (i < 0) i = BOUNDS.length;
    r.hist[i]++;
    // SLO counts only user-facing API traffic, not static files or streams.
    if (route.startsWith('/api/') && route !== '/api/stream') {
      const t = Math.floor(Date.now() / 60_000) * 60_000;
      let b = this.buckets[this.buckets.length - 1];
      if (!b || b.t !== t) {
        b = { t, total: 0, bad: 0 };
        this.buckets.push(b);
        if (this.buckets.length > 60 * 24 * 3) this.buckets.shift();
      }
      b.total++;
      if (status >= 500 || ms > 1000) b.bad++;
    }
  }

  sloBuckets(): Bucket[] {
    return this.buckets;
  }

  cpuSeconds(): number {
    const u = process.cpuUsage(this.cpuStart);
    return (u.user + u.system) / 1e6;
  }

  uptimeSeconds(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  prometheus(): string {
    const lines: string[] = [];
    const rev = `revision="${this.revision}"`;
    lines.push('# HELP clearance_http_requests_total HTTP requests by route and outcome.');
    lines.push('# TYPE clearance_http_requests_total counter');
    for (const [route, r] of this.routes) {
      lines.push(`clearance_http_requests_total{${rev},route="${route}",outcome="ok"} ${r.count - r.errors}`);
      lines.push(`clearance_http_requests_total{${rev},route="${route}",outcome="error"} ${r.errors}`);
    }
    lines.push('# HELP clearance_http_request_duration_ms Request latency histogram.');
    lines.push('# TYPE clearance_http_request_duration_ms histogram');
    for (const [route, r] of this.routes) {
      let cum = 0;
      BOUNDS.forEach((b, i) => {
        cum += r.hist[i];
        lines.push(`clearance_http_request_duration_ms_bucket{${rev},route="${route}",le="${b}"} ${cum}`);
      });
      cum += r.hist[BOUNDS.length];
      lines.push(`clearance_http_request_duration_ms_bucket{${rev},route="${route}",le="+Inf"} ${cum}`);
      lines.push(`clearance_http_request_duration_ms_sum{${rev},route="${route}"} ${r.sumMs.toFixed(3)}`);
      lines.push(`clearance_http_request_duration_ms_count{${rev},route="${route}"} ${r.count}`);
    }
    lines.push('# HELP clearance_process_cpu_seconds_total CPU time used by the Tower.');
    lines.push('# TYPE clearance_process_cpu_seconds_total counter');
    lines.push(`clearance_process_cpu_seconds_total{${rev}} ${this.cpuSeconds().toFixed(3)}`);
    return lines.join('\n') + '\n';
  }
}
