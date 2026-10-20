// The governor playground: the same deterministic engine the pipeline runs,
// executed in the browser so anyone can see how a decision is made.

import { useEffect, useMemo, useState } from 'react';
import { assessRisk } from '../../core/risk.ts';
import { decide } from '../../core/governor.ts';
import { avoidedJobs, plannedJobs } from '../../core/pipeline.ts';
import { DEFAULT_AIRSPACE, DEFAULT_POLICY } from '../../core/config.ts';
import type { Airspace, AutonomyPolicy, FileChange, SecurityFinding } from '../../core/types.ts';
import { Bar, ClearanceScale } from './bits.tsx';
import { LEVEL_LABEL, pct } from './format.ts';

interface Preset {
  name: string;
  files: FileChange[];
  kind?: 'agent' | 'human';
}

const PRESETS: Preset[] = [
  { name: 'Docs fix', files: [{ path: 'docs/guide.md', additions: 4, deletions: 2 }] },
  { name: 'Console tweak with tests', files: [{ path: 'src/web/ui/Strip.tsx', additions: 40, deletions: 8 }, { path: 'test/strip.test.ts', additions: 30, deletions: 0 }] },
  { name: 'Untested engine rewrite', files: [{ path: 'src/core/governor.ts', additions: 180, deletions: 60 }, { path: 'src/tower/server.ts', additions: 30, deletions: 4 }] },
  { name: 'Dependency upgrade', files: [{ path: 'package.json', additions: 2, deletions: 2 }, { path: 'package-lock.json', additions: 140, deletions: 132 }] },
  { name: 'Agent edits its own policy', files: [{ path: '.clearance/policy.yml', additions: 1, deletions: 1 }] },
  { name: 'Database migration', files: [{ path: 'src/db/migrations/0042_add_index.sql', additions: 12, deletions: 0, status: 'added' }, { path: 'test/db.test.ts', additions: 20, deletions: 0 }] },
];

const FINDINGS: Record<string, SecurityFinding[]> = {
  none: [],
  high: [{ severity: 'high', scanner: 'sast', name: 'SQL injection' }],
  critical: [{ severity: 'critical', scanner: 'dependency_scanning', name: 'Remote code execution in a dependency' }],
  secret: [{ severity: 'high', scanner: 'secret_detection', name: 'GitLab personal access token' }],
};

export function Governor() {
  const [config, setConfig] = useState<{ policy: AutonomyPolicy; airspace: Airspace } | null>(null);
  const [files, setFiles] = useState<FileChange[]>(PRESETS[1].files);
  const [kind, setKind] = useState<'agent' | 'human'>('agent');
  const [trust, setTrust] = useState(0.66);
  const [budget, setBudget] = useState(0.8);
  const [finding, setFinding] = useState('none');

  useEffect(() => {
    fetch('/api/policy')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setConfig({ policy: j.policy, airspace: j.airspace }))
      .catch(() => {});
  }, []);

  const policy = config?.policy ?? DEFAULT_POLICY;
  const airspace = config?.airspace ?? DEFAULT_AIRSPACE;

  const result = useMemo(() => {
    const valid = files.filter((f) => f.path.trim());
    const change = { title: 'playground', author: 'you', authorKind: kind, files: valid, findings: FINDINGS[finding] };
    const risk = assessRisk(change, airspace);
    const decision = decide({ change, risk, trust: { pilot: kind === 'agent' ? 'this agent' : 'you', trust }, errorBudget: budget, policy });
    const ctx = { impact: { mode: 'impacted' as const, tests: valid.filter((f) => f.path.startsWith('test/')).map((f) => f.path), reason: '' }, webChanged: valid.some((f) => f.path.startsWith('src/web')) };
    return { risk, decision, planned: plannedJobs(decision.tier, ctx), avoided: avoidedJobs(decision.tier, ctx) };
  }, [files, kind, trust, budget, finding, policy, airspace]);

  const set = (i: number, patch: Partial<FileChange>) => setFiles(files.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const d = result.decision;

  return (
    <div className="governor">
      <p className="lede">Describe a change and who is flying it. The decision below comes from the same code the pipeline runs, using this project’s policy.</p>
      <div className="presets" role="group" aria-label="Example changes">
        {PRESETS.map((p) => (
          <button key={p.name} type="button" className="preset" onClick={() => setFiles(p.files.map((f) => ({ ...f })))}>{p.name}</button>
        ))}
      </div>

      <table className="files">
        <thead><tr><th scope="col">File</th><th scope="col">Added</th><th scope="col">Removed</th><th><span className="sr-only">Remove</span></th></tr></thead>
        <tbody>
          {files.map((f, i) => (
            <tr key={i}>
              <td><input aria-label="File path" value={f.path} onChange={(e) => set(i, { path: e.target.value })} spellCheck={false} /></td>
              <td><input aria-label="Lines added" type="number" min={0} value={f.additions} onChange={(e) => set(i, { additions: Math.max(0, Number(e.target.value)) })} /></td>
              <td><input aria-label="Lines removed" type="number" min={0} value={f.deletions} onChange={(e) => set(i, { deletions: Math.max(0, Number(e.target.value)) })} /></td>
              <td><button type="button" className="icon-btn" aria-label={`Remove ${f.path}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="btn-quiet" onClick={() => setFiles([...files, { path: 'src/', additions: 10, deletions: 0 }])}>Add a file</button>

      <div className="controls-grid">
        <fieldset className="seg">
          <legend>Pilot</legend>
          <label><input type="radio" name="kind" checked={kind === 'agent'} onChange={() => setKind('agent')} /> Duo agent</label>
          <label><input type="radio" name="kind" checked={kind === 'human'} onChange={() => setKind('human')} /> Human</label>
        </fieldset>
        <label className="slider">
          <span>Earned trust <span className="mono">{pct(trust)}</span></span>
          <input type="range" min={0} max={1} step={0.01} value={trust} onChange={(e) => setTrust(Number(e.target.value))} />
        </label>
        <label className="slider">
          <span>Error budget left <span className="mono">{pct(budget)}</span></span>
          <input type="range" min={0} max={1} step={0.01} value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
        </label>
        <label className="select">
          <span>Scanner findings</span>
          <select value={finding} onChange={(e) => setFinding(e.target.value)}>
            <option value="none">None</option>
            <option value="high">High-severity SAST finding</option>
            <option value="critical">Critical dependency vulnerability</option>
            <option value="secret">Leaked token</option>
          </select>
        </label>
      </div>

      <div className={`decision decision-${d.level}`} aria-live="polite">
        <div className="decision-head">
          <span className="decision-level">{LEVEL_LABEL[d.level]}</span>
          <span className="muted small mono">risk {pct(result.risk.score, 1)} · {result.risk.band}</span>
        </div>
        <ClearanceScale risk={result.risk.score} allowance={d.thresholds.autonomous} supervised={d.thresholds.supervised} assisted={d.thresholds.assisted} />
        <ul className="reasons">{d.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
        <ul className="signals">
          {result.risk.signals.map((s) => (
            <li key={s.id}>
              <span className="signal-label">{s.label}</span>
              <Bar value={s.probability} max={0.4} tone={s.id === 'security' ? 'magenta' : 'amber'} label={s.label} />
              <span className="signal-p mono">{pct(s.probability, 1)}</span>
              <span className="signal-detail">{s.detail}</span>
            </li>
          ))}
        </ul>
        <dl className="facts">
          <div><dt>Pipeline</dt><dd>{d.tier}: {result.planned.map((j) => j.name).join(', ') || 'none'}</dd></div>
          <div><dt>Skipped</dt><dd>{result.avoided.length ? result.avoided.map((j) => j.name).join(', ') : 'nothing'}</dd></div>
          <div><dt>Canary</dt><dd>{d.canary ? `${d.canary.steps.map((s) => `${s}%`).join(' · ')}, ${d.canary.bakeSeconds}s per step` : 'no deployment'}</dd></div>
          <div><dt>Approvals</dt><dd>{d.approvalsRequired === 0 ? 'none' : d.approvalsRequired}</dd></div>
        </dl>
      </div>
    </div>
  );
}
