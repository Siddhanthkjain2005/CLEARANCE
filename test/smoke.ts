// Boots the Tower in-process and probes every public endpoint.
// Run: node test/smoke.ts

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

process.env.CLEARANCE_MODE = 'simulated';
process.env.CLEARANCE_TOWER_TOKEN = 'smoke-token';
const { server, store } = await import('../src/tower/server.ts');

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const failures: string[] = [];

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}: ${(e as Error).message}`);
  }
}

const json = async (path: string, init?: RequestInit) => {
  const res = await fetch(base + path, init);
  return { res, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
};

await check('health', async () => {
  const { res, body } = await json('/api/health');
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.ok(res.headers.get('x-clearance-revision'));
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
});

await check('state snapshot', async () => {
  const { res, body } = await json('/api/state');
  assert.equal(res.status, 200);
  for (const k of ['server', 'flights', 'agents', 'budget', 'carbon', 'coverage', 'policy']) assert.ok(k in body, k);
});

await check('governor playground', async () => {
  const { res, body } = await json('/api/assess', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files: [{ path: '.clearance/policy.yml', additions: 1, deletions: 1 }], authorKind: 'agent', trust: 0.9 }),
  });
  assert.equal(res.status, 200);
  assert.equal(body.decision.level, 'hold');
});

await check('playground rejects bad input', async () => {
  const { res } = await json('/api/assess', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"files":[]}' });
  assert.equal(res.status, 422);
});

await check('MCP handshake and tool call', async () => {
  const call = (body: unknown) => json('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
  const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } });
  assert.equal(init.body.result.serverInfo.name, 'clearance-tower');
  const notif = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(notif.status, 202);
  const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(list.body.result.tools.some((t: { name: string }) => t.name === 'assess_change'));
  const res = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'assess_change', arguments: { files: [{ path: 'docs/a.md', additions: 3, deletions: 0 }] } } });
  assert.equal(res.body.result.isError, false);
  assert.equal(res.body.result.structuredContent.level, 'autonomous');
  const bad = await call({ jsonrpc: '2.0', id: 4, method: 'nope' });
  assert.equal(bad.body.error.code, -32601);
});

await check('CI events need the tower token', async () => {
  const ev = [{ type: 'flight.opened', flight: 'CLR-1', at: new Date().toISOString(), title: 'smoke', pilot: 'ai-x', pilotKind: 'agent' }];
  const denied = await fetch(base + '/api/events', { method: 'POST', body: JSON.stringify(ev) });
  assert.equal(denied.status, 401);
  const ok = await json('/api/events', { method: 'POST', headers: { authorization: 'Bearer smoke-token', 'content-type': 'application/json' }, body: JSON.stringify(ev) });
  assert.equal(ok.res.status, 202);
  assert.equal(ok.body.applied, 1);
  assert.ok(store.flights.has('CLR-1'));
});

await check('webhooks need the secret', async () => {
  const res = await fetch(base + '/webhooks/gitlab', { method: 'POST', headers: { 'x-gitlab-event': 'Pipeline Hook' }, body: '{}' });
  assert.equal(res.status, 401);
});

await check('probe and metrics', async () => {
  const p = await json('/api/probe');
  assert.equal(p.res.status, 200);
  const m = await json('/metrics');
  assert.match(m.body, /clearance_http_requests_total\{revision="[^"]+",route="\/api\/probe",outcome="ok"\} 1/);
});

await check('event stream says hello', async () => {
  const ctrl = new AbortController();
  const res = await fetch(base + '/api/stream', { signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body!.getReader();
  let text = '';
  const deadline = Date.now() + 3000;
  while (!text.includes('event: hello') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  ctrl.abort();
  assert.ok(text.includes('event: hello'));
});

await check('unknown API routes are problems, pages fall back to the app', async () => {
  const api = await fetch(base + '/api/nope');
  assert.equal(api.status, 404);
  assert.match(api.headers.get('content-type') ?? '', /problem\+json/);
  const page = await fetch(base + '/tower');
  assert.equal(page.status, 200);
});

server.closeAllConnections?.();
server.close();
console.log(failures.length ? `\n${failures.length} smoke check(s) failed` : '\nall smoke checks passed');
process.exit(failures.length ? 1 : 0);
