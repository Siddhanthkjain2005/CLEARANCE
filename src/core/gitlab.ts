// A minimal GitLab REST client built on fetch. Used by the CI command line
// (with a project access token or CI_JOB_TOKEN) and by the Tower's sync loop.

export interface GitLabOptions {
  baseUrl: string; // e.g. https://gitlab.com/api/v4
  token?: string;
  jobToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class GitLabError extends Error {
  status: number;
  path: string;
  constructor(status: number, path: string, body: string) {
    super(`GitLab ${status} on ${path}: ${body.slice(0, 300)}`);
    this.name = 'GitLabError';
    this.status = status;
    this.path = path;
  }
}

export interface MergeRequest {
  iid: number;
  id: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed' | 'locked' | 'merged';
  author: { username: string; name: string; bot?: boolean };
  labels: string[];
  web_url: string;
  source_branch: string;
  target_branch: string;
  sha: string;
  merge_commit_sha: string | null;
  squash_commit_sha?: string | null;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  head_pipeline?: { id: number; status: string } | null;
}

export interface Pipeline {
  id: number;
  iid: number;
  sha: string;
  ref: string;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
  web_url: string;
}

export interface Job {
  id: number;
  name: string;
  stage: string;
  status: string;
  duration: number | null;
  started_at: string | null;
  finished_at: string | null;
  web_url: string;
  pipeline: { id: number; ref: string; sha: string };
  tag_list?: string[];
}

export interface Deployment {
  id: number;
  iid: number;
  status: string;
  created_at: string;
  updated_at: string;
  sha: string;
  ref: string;
  environment: { name: string };
  deployable?: { id: number; name: string; pipeline: { id: number } };
}

export interface Issue {
  iid: number;
  id: number;
  title: string;
  description: string | null;
  state: string;
  labels: string[];
  author: { username: string };
  web_url: string;
  created_at: string;
  updated_at: string;
  issue_type?: string;
}

export class GitLab {
  private f: typeof fetch;
  private o: GitLabOptions;
  constructor(o: GitLabOptions) {
    this.o = o;
    this.f = o.fetchImpl ?? fetch;
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): GitLab | null {
    const baseUrl = env.CLEARANCE_GITLAB_API ?? env.CI_API_V4_URL ?? (env.GITLAB_URL ? `${env.GITLAB_URL.replace(/\/$/, '')}/api/v4` : undefined);
    const token = env.CLEARANCE_TOKEN ?? env.GITLAB_TOKEN;
    if (!baseUrl || (!token && !env.CI_JOB_TOKEN)) return null;
    return new GitLab({ baseUrl, token, jobToken: token ? undefined : env.CI_JOB_TOKEN });
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json', ...extra };
    if (this.o.token) h['PRIVATE-TOKEN'] = this.o.token;
    else if (this.o.jobToken) h['JOB-TOKEN'] = this.o.jobToken;
    return h;
  }

  async request<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 20_000);
    try {
      const res = await this.f(`${this.o.baseUrl}${path}`, {
        method,
        headers: this.headers(body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}),
        body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new GitLabError(res.status, path, text);
      if (raw) return text as unknown as T;
      return (text ? JSON.parse(text) : null) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  get<T>(path: string) { return this.request<T>('GET', path); }

  async paginate<T>(path: string, maxPages = 5): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= maxPages; page++) {
      const items = await this.get<T[]>(`${path}${sep}per_page=100&page=${page}`);
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  private p(project: string | number) { return `/projects/${encodeURIComponent(String(project))}`; }

  mergeRequest(project: string | number, iid: number) { return this.get<MergeRequest>(`${this.p(project)}/merge_requests/${iid}`); }

  mergeRequestDiffs(project: string | number, iid: number) {
    return this.paginate<{ new_path: string; old_path: string; diff: string; new_file: boolean; deleted_file: boolean; renamed_file: boolean }>(
      `${this.p(project)}/merge_requests/${iid}/diffs`,
    );
  }

  mergeRequests(project: string | number, query = 'state=all&order_by=updated_at') {
    return this.paginate<MergeRequest>(`${this.p(project)}/merge_requests?${query}`, 2);
  }

  mergeRequestsForCommit(project: string | number, sha: string) {
    return this.get<MergeRequest[]>(`${this.p(project)}/repository/commits/${sha}/merge_requests`);
  }

  pipelines(project: string | number, query = 'order_by=id&sort=desc') {
    return this.paginate<Pipeline>(`${this.p(project)}/pipelines?${query}`, 1);
  }

  pipelineJobs(project: string | number, pipelineId: number) {
    return this.paginate<Job>(`${this.p(project)}/pipelines/${pipelineId}/jobs?include_retried=false`, 2);
  }

  pipelineBridges(project: string | number, pipelineId: number) {
    return this.get<{ id: number; name: string; stage: string; status: string; downstream_pipeline: { id: number; status: string } | null }[]>(
      `${this.p(project)}/pipelines/${pipelineId}/bridges`,
    );
  }

  deployments(project: string | number, query = 'order_by=created_at&sort=desc') {
    return this.paginate<Deployment>(`${this.p(project)}/deployments?${query}`, 1);
  }

  issues(project: string | number, query = 'state=all&order_by=updated_at') {
    return this.paginate<Issue>(`${this.p(project)}/issues?${query}`, 1);
  }

  createNote(project: string | number, kind: 'merge_requests' | 'issues', iid: number, body: string) {
    return this.request<{ id: number }>('POST', `${this.p(project)}/${kind}/${iid}/notes`, { body });
  }

  updateMergeRequest(project: string | number, iid: number, fields: Record<string, unknown>) {
    return this.request<MergeRequest>('PUT', `${this.p(project)}/merge_requests/${iid}`, fields);
  }

  /** Sets auto-merge so the MR merges as soon as its pipeline succeeds. */
  autoMerge(project: string | number, iid: number, sha: string) {
    return this.request<MergeRequest>('PUT', `${this.p(project)}/merge_requests/${iid}/merge`, {
      sha,
      auto_merge: true,
      merge_when_pipeline_succeeds: true,
      should_remove_source_branch: true,
    });
  }

  createIssue(project: string | number, fields: { title: string; description: string; labels?: string; issue_type?: 'issue' | 'incident' }) {
    return this.request<Issue>('POST', `${this.p(project)}/issues`, fields);
  }

  createRelease(project: string | number, fields: Record<string, unknown>) {
    return this.request<{ tag_name: string; _links: { self: string } }>('POST', `${this.p(project)}/releases`, fields);
  }

  tags(project: string | number) {
    return this.get<{ name: string; commit: { id: string } }[]>(`${this.p(project)}/repository/tags?order_by=updated&per_page=50`);
  }

  async genericPackageFile(project: string | number, pkg: string, version: string, file: string): Promise<string | null> {
    try {
      return await this.request<string>('GET', `${this.p(project)}/packages/generic/${pkg}/${version}/${file}`, undefined, true);
    } catch (e) {
      if (e instanceof GitLabError && e.status === 404) return null;
      throw e;
    }
  }

  putGenericPackageFile(project: string | number, pkg: string, version: string, file: string, content: string) {
    return this.request<unknown>('PUT', `${this.p(project)}/packages/generic/${pkg}/${version}/${file}`, content);
  }

  jobArtifact(project: string | number, jobId: number, path: string) {
    return this.request<string>('GET', `${this.p(project)}/jobs/${jobId}/artifacts/${path}`, undefined, true);
  }
}
