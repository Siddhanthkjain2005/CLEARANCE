// Sustained load against the Tower: catches latency drift and leaks.
// Run: node test/soak.ts --seconds 60

import type { AddressInfo } from 'node:net';
import { quantile } from '../src/core/stats.ts';

process.env.CLEARANCE_MODE = 'simulated';
const seconds = Number(process.argv[process.argv.indexOf('--seconds') + 1] || 30);
const { server, sim } = await import('../src/tower/server.ts');
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
sim?.start(4);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const paths = ['/api/probe', '/api/probe', '/api/probe', '/api/state', '/api/ledger', '/api/budget'];
const lat: number[] = [];
let errors = 0;
const heapStart = process.memoryUsage().heapUsed;
const end = Date.now() + seconds * 1000;

async function worker() {
  while (Date.now() < end) {
    const t0 = performance.now();
    try {
      const res = await fetch(base + paths[Math.floor(Math.random() * paths.length)]);
      await res.arrayBuffer();
      if (res.status >= 500) errors++;
    } catch {
      errors++;
    }
    lat.push(performance.now() - t0);
  }
}

await Promise.all(Array.from({ length: 16 }, worker));
global.gc?.();
const heapGrowthMb = (process.memoryUsage().heapUsed - heapStart) / 1e6;
const p95 = quantile(lat, 0.95);
const errRate = errors / Math.max(1, lat.length);
console.log(`${lat.length} requests in ${seconds}s · p50 ${quantile(lat, 0.5).toFixed(1)} ms · p95 ${p95.toFixed(1)} ms · errors ${(errRate * 100).toFixed(2)}% · heap +${heapGrowthMb.toFixed(1)} MB`);
sim?.stop();
server.closeAllConnections?.();
server.close();
const ok = p95 < 250 && errRate < 0.005 && heapGrowthMb < 80;
console.log(ok ? 'soak passed' : 'soak FAILED');
process.exit(ok ? 0 : 1);
