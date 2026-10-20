// Clearance Tower: the control tower for autonomous delivery.
//
// One zero-dependency Node process serves the console, a live event stream,
// the REST API, GitLab webhooks, the MCP endpoint for Duo agents, Prometheus
// metrics, and a probe endpoint that canary analysis measures.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, constants as zc } from 'node:zlib';
import { parseAirspace, parsePolicy } from '../core/config.ts';
import { decide } from '../core/governor.ts';
import { assessRisk } from '../core/risk.ts';
import { scorePilot } from '../core/trust.ts';
import { budgetStatus } from '../core/slo.ts';
import { runtimeSci, gridIntensity } from '../core/sci.ts';
import { GitLab } from '../core/gitlab.ts';
import { isFlightEvent, type FlightEvent } from '../core/events.ts';
import { STAGES, type ChangeSet, type FileChange, type SecurityFinding } from '../core/types.ts';
import { Metrics } from './metrics.ts';
import { Store } from './store.ts';
import { Simulator } from './simulator.ts';
import { GitLabSync } from './sync.ts';
import { McpServer } from './mcp.ts';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const env = process.env;
const PORT = Number(env.PORT ?? 8080);
const WEB_DIR = resolve(env.CLEARANCE_WEB_DIR ?? join(ROOT, 'dist/web'));
const REGION = env.CLEARANCE_REGION ?? 'northamerica-northeast1';
const COMMIT = (env.CLEARANCE_COMMIT ?? 'dev').slice(0, 12);
const ROLE = env.CLEARANCE_ROLE ?? 'stable';
const DRILL = env.CLEARANCE_DRILL ?? '';

const readMaybe = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const policyYaml = readMaybe(join(ROOT, '.clearance/policy.yml'));
const airspaceYaml = readMaybe(join(ROOT, '.clearance/airspace.yml'));
const policy = parsePolicy(policyYaml);
const airspace = parseAirspace(airspaceYaml);

const metrics = new Metrics();
const store = new Store(policy, env.CLEARANCE_DATA_DIR ?? null);

const gitlabToken = env.CLEARANCE_GITLAB_TOKEN;
const project = env.CLEARANCE_PROJECT;
const gitlabUrl = (env.CLEARANCE_GITLAB_URL ?? 'https://gitlab.com').replace(/\/$/, '');
const requestedMode = env.CLEARANCE_MODE ?? 'auto';
const live = requestedMode !== 'simulated' && !!gitlabToken && !!project;
const simulate = requestedMode === 'simulated' || requestedMode === 'both' || (requestedMode === 'auto' && !live);

const sync = live ? new GitLabSync(store, new GitLab({ baseUrl: `${gitlabUrl}/api/v4`, token: gitlabToken }), project!) : null;
const sim = simulate ? new Simulator(store, airspace, { seed: env.CLEARANCE_SIM_SEED ? Number(env.CLEARANCE_SIM_SEED) : undefined, speed: Number(env.CLEARANCE_SIM_SPEED ?? 1) }) : null;

function errorBudget(): number {
  if (env.CLEARANCE_ERROR_BUDGET) return Number(env.CLEARANCE_ERROR_BUDGET);
  if (sim && !live) return Math.round(sim.budget * 1000) / 1000;
  return budgetStatus(metrics.sloBuckets(), policy.analysis.sloTarget).remaining;
}

const mcp = new McpServer(store, airspace, errorBudget);

// ------------------------------------------------------------------ helpers

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-clearance-revision': metrics.revision, 'x-clearance-role': ROLE, ...SECURITY_HEADERS, ...extra };
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const enc = String(req.headers['accept-encoding'] ?? '');
  const headers = baseHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...extra });
  if (raw.length > 1400 && /\bbr\b/.test(enc)) {
    res.writeHead(status, { ...headers, 'Content-Encoding': 'br' });
    res.end(brotliCompressSync(raw, { params: { [zc.BROTLI_PARAM_QUALITY]: 4 } }));
  } else if (raw.length > 1400 && /\bgzip\b/.test(enc)) {
    res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip' });
    res.end(gzipSync(raw, { level: 6 }));
  } else {
    res.writeHead(status, headers);
    res.end(raw);
  }
}

function problem(req: IncomingMessage, res: ServerResponse, status: number, title: string, detail?: string) {
  sendJson(req, res, status, { type: 'about:blank', title, status, ...(detail ? { detail } : {}) }, { 'Content-Type': 'application/problem+json' });
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw Object.assign(new Error('payload too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('body is not valid JSON'), { status: 400 });
  }
}

function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Token-bucket rate limiting per client for write endpoints.
const buckets = new Map<string, { tokens: number; at: number }>();
function allow(req: IncomingMessage, perMinute: number): boolean {
  const key = `${String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim()}:${req.url?.split('?')[0]}`;
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: perMinute, at: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  if (buckets.size > 10_000) buckets.clear();
  return true;
}

// ------------------------------------------------------------------ static files

interface Asset { body: Buffer; gz: Buffer; br: Buffer; type: string; etag: string; immutable: boolean }
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
const assets = new Map<string, Asset>();

function loadAssets(dir: string, prefix = '') {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { loadAssets(p, `${prefix}/${name}`); continue; }
    const body = readFileSync(p);
    const type = TYPES[extname(name)] ?? 'application/octet-stream';
    const compressible = /text|javascript|json|svg|manifest/.test(type);
    assets.set(`${prefix}/${name}`, {
      body,
      gz: compressible ? gzipSync(body, { level: 9 }) : body,
      br: compressible ? brotliCompressSync(body, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } }) : body,
      type,
      etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`,
      immutable: /-[A-Z0-9]{8}\.(js|css)$/i.test(name) || name.endsWith('.woff2'),
    });
  }
}
loadAssets(WEB_DIR);

function serveAsset(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  const clean = normalize(path).split(sep).join('/');
  let a = assets.get(clean);
  if (!a && !extname(clean)) a = assets.get('/index.html'); // client-side routes
  if (!a) return false;
  if (req.headers['if-none-match'] === a.etag) {
    res.writeHead(304, baseHeaders({ ETag: a.etag }));
    res.end();
    return true;
  }
  const enc = String(req.headers['accept-encoding'] ?? '');
  const useBr = /\bbr\b/.test(enc) && a.br !== a.body;
  const useGz = !useBr && /\bgzip\b/.test(enc) && a.gz !== a.body;
  res.writeHead(200, baseHeaders({
    'Content-Type': a.type,
    ETag: a.etag,
    Vary: 'Accept-Encoding',
    'Cache-Control': a.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...(useBr ? { 'Content-Encoding': 'br' } : useGz ? { 'Content-Encoding': 'gzip' } : {}),
  }));
  res.end(req.method === 'HEAD' ? undefined : useBr ? a.br : useGz ? a.gz : a.body);
  return true;
}

// ------------------------------------------------------------------ state views

function mode() {
  return live && simulate ? 'mixed' : live ? 'live' : 'simulated';
}

function serverInfo() {
  return {
    mode: mode(),
    revision: metrics.revision,
    role: ROLE,
    commit: COMMIT,
    region: REGION,
    uptimeSeconds: Math.round(metrics.uptimeSeconds()),
    project: live ? { path: project, url: sync?.projectUrl ?? null, lastSync: sync?.lastSync ?? null, lastError: sync?.lastError ?? null } : null,
    drill: DRILL || null,
  };
}

function carbon() {
  const rt = runtimeSci(metrics.cpuSeconds(), metrics.uptimeSeconds(), metrics.requests, REGION);
  return { flights: store.carbon(), runtime: { ...rt, region: REGION, intensity: gridIntensity(REGION), requests: metrics.requests } };
}

function budget() {
  const remaining = errorBudget();
  const status = budgetStatus(metrics.sloBuckets(), policy.analysis.sloTarget);
  return { remaining, source: env.CLEARANCE_ERROR_BUDGET ? 'override' : sim && !live ? 'simulated' : 'tower-slo', target: policy.analysis.sloTarget, alerts: status.alerts, tightenBelow: policy.errorBudget.tightenBelow, freezeBelow: policy.errorBudget.freezeBelow };
}

function snapshot() {
  return {
    server: serverInfo(),
    stages: STAGES,
    flights: store.flightList().slice(0, 40),
    tape: store.tape.slice(-60),
    agents: store.agents(),
    budget: budget(),
    carbon: carbon(),
    coverage: store.coverage(),
    policy: { autonomous: policy.autonomous, supervised: policy.supervised, assisted: policy.assisted, errorBudget: policy.errorBudget, holds: policy.holds, canary: policy.canary },
  };
}

// ------------------------------------------------------------------ SSE

const streams = new Set<ServerResponse>();
function sse(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
store.subscribe((msg) => {
  for (const s of streams) {
    if (msg.kind === 'flight') sse(s, 'flight', msg.flight);
    else if (msg.kind === 'tape') sse(s, 'tape', msg.item);
    else if (msg.kind === 'ledger') sse(s, 'ledger', msg.agents);
    else if (msg.kind === 'remove') sse(s, 'remove', { id: msg.id });
  }
});
setInterval(() => {
  if (streams.size === 0) return;
  const pulse = { budget: budget(), carbon: carbon(), coverage: store.coverage(), server: serverInfo() };
  for (const s of streams) {
    sse(s, 'pulse', pulse);
  }
}, 5000).unref();

// ------------------------------------------------------------------ probe (canary workload)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function probe(req: IncomingMessage, res: ServerResponse) {
  // Representative work: score a synthetic change through the real engine.
  const files: FileChange[] = [{ path: 'src/web/ui/Strip.tsx', additions: 40 + Math.floor(Math.random() * 40), deletions: 8 }, { path: 'test/strip.test.ts', additions: 30, deletions: 0 }];
  const change: ChangeSet = { title: 'probe', author: 'probe', authorKind: 'agent', files };
  const risk = assessRisk(change, airspace);
  const d = decide({ change, risk, trust: scorePilot('probe', [], policy), errorBudget: 1, policy });
  if (DRILL === 'latency') await sleep(60 + Math.random() * 90);
  if (DRILL === 'errors' && Math.random() < 0.08) return problem(req, res, 503, 'Drill: injected failure', 'CLEARANCE_DRILL=errors is set on this revision');
  sendJson(req, res, 200, { ok: true, revision: metrics.revision, role: ROLE, level: d.level, risk: risk.score });
}

// ------------------------------------------------------------------ router

async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
  const url = new URL(req.url ?? '/', 'http://tower');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/api/health') { sendJson(req, res, 200, { ok: true, revision: metrics.revision, mode: mode() }); return path; }
  if (path === '/api/state' && method === 'GET') { sendJson(req, res, 200, snapshot()); return path; }
  if (path === '/api/budget') { sendJson(req, res, 200, budget()); return path; }
  if (path === '/api/carbon') { sendJson(req, res, 200, carbon()); return path; }
  if (path === '/api/ledger') { sendJson(req, res, 200, { agents: store.agents(), entries: store.ledgerEntries().slice(-300) }); return path; }
  if (path === '/api/policy') { sendJson(req, res, 200, { policy, airspace, yaml: { policy: policyYaml, airspace: airspaceYaml } }); return path; }
  if (path === '/api/flights') { sendJson(req, res, 200, store.flightList()); return path; }
  if (path.startsWith('/api/flights/')) {
    const f = store.flights.get(decodeURIComponent(path.slice('/api/flights/'.length)));
    if (!f) problem(req, res, 404, 'No such flight');
    else sendJson(req, res, 200, { flight: f, tape: store.tape.filter((t) => t.flight === f.id) });
    return '/api/flights/:id';
  }
  if (path === '/api/probe') { await probe(req, res); return path; }

  if (path === '/api/stream') {
    res.writeHead(200, baseHeaders({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }));
    res.write('retry: 3000\n\n');
    sse(res, 'hello', snapshot());
    streams.add(res);
    const beat = setInterval(() => res.write(': beat\n\n'), 15_000);
    req.on('close', () => { clearInterval(beat); streams.delete(res); });
    return path;
  }

  if (path === '/api/assess' && method === 'POST') {
    if (!allow(req, 60)) { problem(req, res, 429, 'Slow down', 'At most 60 assessments per minute'); return path; }
    const body = (await readBody(req, 200_000)) as { files?: FileChange[]; authorKind?: 'agent' | 'human'; trust?: number; errorBudget?: number; findings?: SecurityFinding[]; title?: string };
    if (!Array.isArray(body.files) || body.files.length === 0 || body.files.length > 500) { problem(req, res, 422, 'files must be a non-empty array of at most 500 changes'); return path; }
    const files = body.files.map((f) => ({ path: String(f.path ?? '').slice(0, 300), additions: Math.max(0, Math.min(1e6, Number(f.additions) || 0)), deletions: Math.max(0, Math.min(1e6, Number(f.deletions) || 0)), status: f.status }));
    const change: ChangeSet = { title: String(body.title ?? 'playground change').slice(0, 200), author: 'playground', authorKind: body.authorKind === 'human' ? 'human' : 'agent', files, findings: Array.isArray(body.findings) ? body.findings.slice(0, 50) : [] };
    const risk = assessRisk(change, airspace);
    const t = typeof body.trust === 'number' ? Math.max(0, Math.min(1, body.trust)) : scorePilot('playground', [], policy).trust;
    const eb = typeof body.errorBudget === 'number' ? Math.max(0, Math.min(1, body.errorBudget)) : errorBudget();
    sendJson(req, res, 200, { risk, decision: decide({ change, risk, trust: { pilot: 'playground', trust: t }, errorBudget: eb, policy }) });
    return path;
  }

  if (path === '/api/events' && method === 'POST') {
    const token = env.CLEARANCE_TOWER_TOKEN;
    const auth = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token || !safeEqual(auth, token)) { problem(req, res, 401, 'A valid CLEARANCE_TOWER_TOKEN bearer token is required'); return path; }
    if (!allow(req, 600)) { problem(req, res, 429, 'Slow down'); return path; }
    const body = await readBody(req, 2_000_000);
    const list = (Array.isArray(body) ? body : [body]).filter(isFlightEvent).map((e) => ({ ...(e as FlightEvent), source: 'ci' as const }));
    const applied = store.ingest(list);
    sendJson(req, res, 202, { accepted: list.length, applied });
    return path;
  }

  if (path === '/webhooks/gitlab' && method === 'POST') {
    const secret = env.CLEARANCE_WEBHOOK_SECRET;
    if (!secret || !safeEqual(String(req.headers['x-gitlab-token'] ?? ''), secret)) { problem(req, res, 401, 'Invalid webhook token'); return path; }
    if (!allow(req, 1200)) { problem(req, res, 429, 'Slow down'); return path; }
    const body = (await readBody(req, 5_000_000)) as Record<string, unknown>;
    const kind = String(req.headers['x-gitlab-event'] ?? '');
    const applied = sync ? sync.handleWebhook(kind, body) : 0;
    sendJson(req, res, 202, { event: kind, applied });
    return path;
  }

  if (path === '/mcp') {
    if (method === 'GET' || method === 'DELETE') { res.writeHead(405, baseHeaders({ Allow: 'POST' })); res.end(); return path; }
    if (method !== 'POST') { problem(req, res, 405, 'Use POST'); return path; }
    const token = env.CLEARANCE_MCP_TOKEN;
    if (token && !safeEqual(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''), token)) { problem(req, res, 401, 'Invalid MCP token'); return path; }
    if (!allow(req, 300)) { problem(req, res, 429, 'Slow down'); return path; }
    const out = mcp.handleBody(await readBody(req, 2_000_000));
    if (out === null) { res.writeHead(202, baseHeaders()); res.end(); }
    else sendJson(req, res, 200, out);
    return path;
  }

  if (path === '/metrics') {
    res.writeHead(200, baseHeaders({ 'Content-Type': 'text/plain; version=0.0.4' }));
    res.end(metrics.prometheus());
    return path;
  }

  if ((method === 'GET' || method === 'HEAD') && !path.startsWith('/api/')) {
    if (serveAsset(req, res, path)) return path.includes('.') ? 'static' : 'page';
    if (assets.size === 0) {
      res.writeHead(200, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
      res.end('Clearance Tower is running. Build the console with `npm run build:web` to see it here.\n');
      return 'page';
    }
  }
  problem(req, res, 404, 'Not found');
  return 'not-found';
}

export const server = createServer(async (req, res) => {
  const t0 = performance.now();
  let label = 'unknown';
  try {
    label = await route(req, res);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    if (!res.headersSent) problem(req, res, status, status === 500 ? 'Internal error' : (e as Error).message);
    if (status === 500) console.error(e);
  } finally {
    if (label !== '/api/stream') metrics.observe(label, res.statusCode, performance.now() - t0);
  }
});

server.keepAliveTimeout = 65_000; // longer than Cloud Run's load balancer idle timeout
server.headersTimeout = 66_000;

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  server.listen(PORT, () => {
    console.log(`Clearance Tower on :${PORT} · mode ${mode()} · revision ${metrics.revision} · ${assets.size} assets`);
    sync?.start(Number(env.CLEARANCE_SYNC_MS ?? 20_000));
    sim?.start();
  });
  const shutdown = () => {
    sim?.stop();
    sync?.stop();
    for (const s of streams) s.end();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export { store, sim, sync, metrics };
