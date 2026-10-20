// An in-memory stand-in for the parts of the GitLab REST API Clearance uses.
// It records every call so tests can assert what the CLI and the Tower did.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockCall {
  method: string;
  path: string;
  body: unknown;
  auth: string;
}

export interface MockMr {
  iid: number;
  title: string;
  description: string;
  state: string;
  labels: string[];
  author: { username: string; name: string };
  sha: string;
  merge_commit_sha: string | null;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  head_pipeline: { id: number; status: string } | null;
  source_branch: string;
  target_branch: string;
}

export class GitLabMock {
  calls: MockCall[] = [];
  mrs = new Map<number, MockMr>();
  notes = new Map<string, { id: number; body: string; author: { username: string; name: string }; created_at: string; system: boolean }[]>();
  packages = new Map<string, string>();
  issues: Record<string, unknown>[] = [];
  releases = new Map<string, { tag_name: string; name: string; description: string }>();
  pipelines: { id: number; sha: string; status: string; jobs: Record<string, unknown>[]; bridges: Record<string, unknown>[] }[] = [];
  private server: Server;
  private nextId = 1000;
  url = '';

  constructor() {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* generic package uploads are raw text */ }
      const url = new URL(req.url ?? '/', 'http://mock');
      const path = decodeURIComponent(url.pathname.replace(/^\/api\/v4/, ''));
      const auth = String(req.headers['private-token'] ?? req.headers['job-token'] ?? '');
      this.calls.push({ method: req.method ?? 'GET', path: path + url.search, body, auth });
      const out = this.route(req.method ?? 'GET', path, url.searchParams, body, auth);
      if (out === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"message":"404 Not Found"}');
        return;
      }
      if (typeof out === 'string') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(out);
        return;
      }
      res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/api/v4`;
    return this.url;
  }

  stop() {
    this.server.closeAllConnections?.();
    this.server.close();
  }

  callsTo(method: string, pattern: RegExp) {
    return this.calls.filter((c) => c.method === method && pattern.test(c.path));
  }

  private route(method: string, path: string, q: URLSearchParams, body: any, auth: string): unknown {
    let m: RegExpMatchArray | null;
    const P = '/projects/[^/]+';
    if ((m = path.match(new RegExp(`^${P}/packages/generic/([^/]+)/([^/]+)/([^/]+)$`)))) {
      const key = `${m[1]}/${m[2]}/${m[3]}`;
      if (method === 'PUT') { this.packages.set(key, typeof body === 'string' ? body : JSON.stringify(body)); return { message: '201 Created' }; }
      return this.packages.get(key);
    }
    if (method === 'GET' && (m = path.match(new RegExp(`^${P}/merge_requests$`)))) return [...this.mrs.values()].map((mr) => ({ ...mr, web_url: `https://gitlab.example/g/p/-/merge_requests/${mr.iid}` }));
    if ((m = path.match(new RegExp(`^${P}/merge_requests/(\\d+)$`)))) {
      const mr = this.mrs.get(Number(m[1]));
      if (!mr) return undefined;
      if (auth === 'job-token-only') return undefined; // job tokens can't read MRs
      if (method === 'PUT') {
        if (body?.add_labels) for (const l of String(body.add_labels).split(',')) {
          const scope = l.includes('::') ? l.split('::')[0] : null;
          mr.labels = mr.labels.filter((x) => !(scope && x.startsWith(`${scope}::`)));
          mr.labels.push(l);
        }
      }
      return { ...mr, web_url: `https://gitlab.example/g/p/-/merge_requests/${mr.iid}`, id: mr.iid };
    }
    if ((m = path.match(new RegExp(`^${P}/merge_requests/(\\d+)/merge$`))) && method === 'PUT') {
      const mr = this.mrs.get(Number(m[1]))!;
      return { ...mr, merge_when_pipeline_succeeds: true };
    }
    if ((m = path.match(new RegExp(`^${P}/merge_requests/(\\d+)/approval_rules$`)))) return { id: 1, ...body };
    if ((m = path.match(new RegExp(`^${P}/merge_requests/(\\d+)/notes(?:/(\\d+))?$`)))) {
      const list = this.notes.get(m[1]) ?? [];
      this.notes.set(m[1], list);
      if (method === 'POST') {
        const n = { id: this.nextId++, body: body.body, author: { username: 'project_bot', name: 'bot' }, created_at: new Date().toISOString(), system: false };
        list.push(n);
        return n;
      }
      if (method === 'PUT' && m[2]) {
        const n = list.find((x) => x.id === Number(m![2]));
        if (n) n.body = body.body;
        return n;
      }
      return [...list].reverse();
    }
    if ((m = path.match(new RegExp(`^${P}/repository/commits/([0-9a-f]+)/merge_requests$`)))) {
      return [...this.mrs.values()].filter((mr) => mr.merge_commit_sha === m![1] || mr.sha === m![1]);
    }
    if (method === 'GET' && path.match(new RegExp(`^${P}/pipelines$`))) {
      const sha = q.get('sha');
      return this.pipelines.filter((p) => !sha || p.sha === sha).map((p) => ({ id: p.id, sha: p.sha, status: p.status }));
    }
    if ((m = path.match(new RegExp(`^${P}/pipelines/(\\d+)/jobs$`)))) return this.pipelines.find((p) => p.id === Number(m![1]))?.jobs ?? [];
    if ((m = path.match(new RegExp(`^${P}/pipelines/(\\d+)/bridges$`)))) return this.pipelines.find((p) => p.id === Number(m![1]))?.bridges ?? [];
    if (path.match(new RegExp(`^${P}/issues$`))) {
      if (method === 'POST') {
        const issue = { iid: this.issues.length + 1, id: this.nextId++, web_url: `https://gitlab.example/g/p/-/issues/${this.issues.length + 1}`, state: 'opened', labels: String(body.labels ?? '').split(','), author: { username: 'project_bot' }, created_at: new Date().toISOString(), ...body };
        this.issues.push(issue);
        return issue;
      }
      return this.issues;
    }
    if (path.match(new RegExp(`^${P}/releases$`)) && method === 'POST') {
      const rel = { tag_name: body.tag_name, name: body.name, description: body.description, _links: { self: `https://gitlab.example/g/p/-/releases/${body.tag_name}` } };
      this.releases.set(body.tag_name, rel);
      return rel;
    }
    if ((m = path.match(new RegExp(`^${P}/releases/([^/]+)$`)))) {
      const rel = this.releases.get(m[1]);
      if (!rel) return undefined;
      if (method === 'PUT') Object.assign(rel, body);
      return rel;
    }
    return undefined;
  }
}
