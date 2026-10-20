// The front page follows a real delivery lifecycle while the persistent 3D
// airspace moves through the same nine chapters behind it.

import type { MouseEvent } from 'react';
import type { Snapshot } from '../state.ts';
import { navigate } from '../state.ts';
import { ModeChip, Wordmark } from './Console.tsx';
import { isAirborne, PilotMark } from './bits.tsx';
import { grams, pct } from './format.ts';
import './landing.css';

const APPROACH = [
  { stage: 'Plan', title: 'Start with an intent.', who: 'Dispatch agent', what: 'Describe the outcome in a GitLab issue. Dispatch turns it into a flight plan and predicts clearance before a line of code is written.', artifact: 'Intent issue → flight plan', detail: 'Assess risk before implementation' },
  { stage: 'Create', title: 'A pilot takes the controls.', who: 'Dispatch agent', what: 'The agent implements the change, writes its tests and opens a merge request. Every signed commit carries a pilot identity, so every outcome has an owner.', artifact: 'Signed commit → merge request', detail: 'Implementation with an accountable pilot' },
  { stage: 'Verify', title: 'The right checks for the flight.', who: 'Risk-adaptive pipeline', what: 'A small change gets focused tests. A riskier one gets the full suite and a soak test. The Inspector reviews the diff and sends it back for rework when needed.', artifact: 'Adaptive pipeline + inspection', detail: 'Verification depth follows risk' },
  { stage: 'Package', title: 'Build once. Carry the proof.', who: 'CI', what: 'The pipeline builds the container once, then attaches its software bill of materials and build provenance. The artifact that passed verification is the one that flies.', artifact: 'Container + SBOM + provenance', detail: 'A traceable release artifact' },
  { stage: 'Secure', title: 'Ask the tower for clearance.', who: 'Scanners and governor', what: 'Security scans meet a deterministic gate. The governor weighs change risk, pilot trust and the service’s error budget, then decides how much human involvement the flight needs.', artifact: 'Scans → policy decision', detail: 'Autonomous · supervised · assisted · hold' },
  { stage: 'Release', title: 'A release with a flight record.', who: 'CI', what: 'A semantic version and release notes travel with the pilot, risk, clearance and evidence pack. You can trace what shipped back to the decision that allowed it.', artifact: 'Version + release notes + evidence', detail: 'The reason for release stays attached' },
  { stage: 'Configure', title: 'Line up for a safe approach.', who: 'Terraform and Cloud Run', what: 'The pipeline deploys a tagged canary revision with zero traffic. Production stays on the stable revision while the new arrival gets ready.', artifact: 'Tagged canary · zero initial traffic', detail: 'Prepare the revision before exposure' },
  { stage: 'Monitor', title: 'Watch the landing. Be ready to turn.', who: 'Canary analysis', what: 'Traffic moves in steps sized by clearance. Statistical checks and SLO burn rates watch the canary. A failing revision goes around automatically, restoring the stable one.', artifact: 'Traffic steps → canary verdict', detail: 'Automatic rollback when the canary fails' },
  { stage: 'Govern', title: 'Every landing changes the next.', who: 'Ledger, black box and Debrief', what: 'The outcome updates pilot trust, seals a hash-chained evidence pack and records carbon per change. After a go-around, Debrief reconstructs the timeline and writes the postmortem.', artifact: 'Trust ledger + sealed flight record', detail: 'Earn autonomy through observed outcomes' },
];

const FLOWS = [
  { name: 'Dispatch', trigger: 'Intent issue', description: 'Dispatcher, Pilot and Inspector plan, implement and review the change, with a rework loop.' },
  { name: 'Medic', trigger: 'Failed pipeline', description: 'Reads job logs and pushes a minimal fix to the same branch. A policy hold stays in place.' },
  { name: 'Debrief', trigger: 'Go-around incident', description: 'Reconstructs the timeline from the black box and writes a postmortem grounded in the evidence.' },
];

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d={diagonal ? 'M5 15 15 5M5 5h10v10' : 'M3 10h13m-5-5 5 5-5 5'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function ApproachChart() {
  const points = APPROACH.map((_, i) => [36 + i * 111, 22 + i * 12] as const);
  return (
    <div className="home-route" aria-label="Nine gates from intent to production">
      <svg className="home-route-chart" viewBox="0 0 960 158" aria-hidden="true">
        <path d="M0 128h960" stroke="currentColor" strokeOpacity=".14" />
        <polyline points={points.map((p) => p.join(',')).join(' ')} fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="3 5" />
        {points.map(([x, y], i) => <g key={i}><path d={`M${x} ${y + 7}v${120 - y}`} stroke="currentColor" strokeOpacity=".14" /><circle cx={x} cy={y} r="4" fill="var(--home-bg)" stroke="currentColor" /><text x={x} y={y - 12} textAnchor="middle">{String(i + 1).padStart(2, '0')}</text></g>)}
        <path d="M878 124h68v9h-68zM894 128h5m5 0h5m5 0h5m5 0h5" fill="none" stroke="var(--home-amber)" />
      </svg>
      <ol className="home-route-labels">
        {APPROACH.map((a, i) => <li key={a.stage}><a href={`#flight-${i + 1}`}><span>{String(i + 1).padStart(2, '0')}</span>{a.stage}</a></li>)}
      </ol>
    </div>
  );
}

export function Landing({ s }: { s: Snapshot }) {
  const air = s.flights.filter(isAirborne);
  const holding = air.filter((f) => f.phase === 'holding').length;
  const go = (p: string) => (e: MouseEvent) => { e.preventDefault(); navigate(p); };
  const agents = s.agents.slice(0, 4);
  const minTrust = s.policy?.autonomous.minTrust ?? 0.55;
  const maxRisk = s.policy?.autonomous.maxRisk ?? 0.35;
  const measured = !!s.carbon?.flights.flights;

  return (
    <div className="home">
      <header className="home-header">
        <Wordmark />
        <nav className="home-nav" aria-label="Site">
          <a className="home-nav-link" href="#approach">The flight path</a>
          <a className="home-nav-link" href="/governor" onClick={go('/governor')}>The governor</a>
          <a className="home-nav-tower" href="/tower" onClick={go('/tower')}>Enter the tower <Arrow diagonal /></a>
        </nav>
      </header>

      <section className="home-hero" data-flight-chapter={0} aria-labelledby="home-title">
        <div className="home-hero-copy">
          <p className="home-eyebrow"><span className="home-beacon" /> A control tower for autonomous delivery</p>
          <h1 id="home-title">Your code.<br /><span>Cleared for</span><br />takeoff.</h1>
          <p className="home-intro">See every software change from intent to production. Explore risk, earned trust and policy in one interactive airspace.</p>
          <div className="home-actions">
            <a className="home-button" href="/tower" onClick={go('/tower')}>Open the tower <Arrow /></a>
            <a className="home-text-link" href="#approach">Explore the flight path <span>↓</span></a>
          </div>
        </div>
        <div className="home-hero-telemetry" aria-label="Current tower status">
          <span className="home-telemetry-heading">Tower status</span>
          <ModeChip s={s} />
          <span className="home-telemetry-flight"><b>{String(air.length).padStart(2, '0')}</b> flights in the air{holding > 0 && <em>{holding} holding</em>}</span>
        </div>
        <div className="home-hero-bottom">
          <a href="#approach"><span className="home-scroll-line" /> Scroll to follow the approach</a>
          <span>Intent <span className="home-bottom-arrow">↗</span> Production</span>
        </div>
      </section>

      <section id="approach" className="home-approach" aria-labelledby="home-approach-title">
        <div className="home-wrap">
          <div className="home-section-heading">
            <p className="home-eyebrow">01 / The flight path</p>
            <h2 id="home-approach-title">One intent.<br />Nine gates. <span>A safe arrival.</span></h2>
            <p>Every change is a flight. Follow it through the delivery lifecycle while the tower keeps risk, trust and evidence in view.</p>
          </div>
          <ApproachChart />
        </div>
      </section>

      <div className="home-chapters">
        {APPROACH.map((a, i) => (
          <section id={`flight-${i + 1}`} key={a.stage} className={`home-chapter${i % 2 ? ' home-chapter-right' : ''}`} data-flight-chapter={i + 1} aria-labelledby={`flight-title-${i + 1}`}>
            <div className="home-chapter-inner">
              <div className="home-chapter-copy">
                <p className="home-chapter-index"><span>{String(i + 1).padStart(2, '0')}</span><span className="home-index-rule" />{a.stage}</p>
                <h3 id={`flight-title-${i + 1}`}>{a.title}</h3>
                <p className="home-chapter-description">{a.what}</p>
                <div className="home-chapter-artifact"><span className="home-artifact-icon">↳</span><div><span className="home-label">{a.who}</span><strong>{a.artifact}</strong></div></div>
              </div>
              <div className="home-chapter-caption"><span>{String(i + 1).padStart(2, '0')} / 09</span><p>{a.detail}</p></div>
            </div>
          </section>
        ))}
      </div>

      <section className="home-principles">
        <div className="home-wrap">
          <div className="home-section-heading home-principles-heading">
            <p className="home-eyebrow">02 / The rules of the airspace</p>
            <h2>Let agents move fast.<br /><span>Keep the controls.</span></h2>
          </div>

          <article className="home-principle home-trust">
            <div className="home-principle-copy">
              <span className="home-principle-no">01 — Trust</span>
              <h3>Autonomy is earned.<br />Flight by flight.</h3>
              <p>A new pilot starts supervised. Clean landings build its track record; a go-around changes it. The governor uses a conservative trust estimate, and shrinks everyone’s autonomy when the service burns its error budget.</p>
              <a className="home-text-link" href="/ledger" onClick={go('/ledger')}>Explore the trust ledger <Arrow diagonal /></a>
            </div>
            <div className="home-ledger">
              <div className="home-instrument-head"><span>Pilot trust</span><span><ModeChip s={s} /></span></div>
              <ul aria-label="Current pilot trust">
                {agents.map((a) => <li key={a.pilot}><div className="home-pilot-row"><PilotMark name={a.pilot} /><span>{pct(a.trust)}</span></div><div className="home-trust-track" role="meter" aria-label={`${a.pilot} trust`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(a.trust * 100)}><span style={{ width: pct(a.trust) }} /><i style={{ left: pct(minTrust) }} /></div></li>)}
                {!agents.length && <li className="home-awaiting">Waiting for the tower’s pilot ledger.</li>}
              </ul>
              <p className="home-instrument-note"><span className="home-threshold-key" /> {pct(minTrust)} minimum trust for autonomous flight</p>
            </div>
          </article>

          <article className="home-principle home-policy">
            <div className="home-principle-copy">
              <span className="home-principle-no">02 — Policy</span>
              <h3>The agent proposes.<br />The governor decides.</h3>
              <p>Clearance comes from deterministic code. The governor cites the policy behind each decision and gives the same answer for the same inputs. Protected rules remain under human control.</p>
              <a className="home-text-link" href="/governor" onClick={go('/governor')}>Try a change in the governor <Arrow diagonal /></a>
            </div>
            <div className="home-policy-window">
              <div className="home-instrument-head"><span><span className="home-policy-dot" /> .clearance/policy.yml</span><span>{s.policy ? 'Tower snapshot' : 'Default policy'}</span></div>
              <pre aria-label="Current autonomous policy thresholds"><code><span className="home-code-dim"># Clearance follows policy</span>{'\n'}autonomy:{'\n'}  autonomous:{'\n'}    max_risk: <span className="home-code-value">{maxRisk.toFixed(2)}</span>{'\n'}    min_trust: <span className="home-code-value">{minTrust.toFixed(2)}</span>{'\n'}{'\n'}<span className="home-code-dim"># Protected sectors always hold</span>{'\n'}holds:{'\n'}  - <span className="home-code-value">protected_sectors</span></code></pre>
              <div className="home-policy-verdict"><span className="home-beacon" /> Same inputs. Same decision.</div>
            </div>
          </article>

          <article className="home-principle home-carbon">
            <div className="home-principle-copy">
              <span className="home-principle-no">03 — Footprint</span>
              <h3>Less unnecessary work.<br />A measured footprint.</h3>
              <p>A docs fix doesn’t need the soak test of a core rewrite. Verification follows risk, and Clearance counts the avoided work in Software Carbon Intensity per change shipped.</p>
              <a className="home-text-link" href="/carbon" onClick={go('/carbon')}>Open the carbon report <Arrow diagonal /></a>
            </div>
            <div className="home-carbon-readout">
              <div className="home-instrument-head"><span>Carbon per change</span><span>{s.server?.mode === 'simulated' ? 'Simulated flights' : 'Tower measurements'}</span></div>
              <div className="home-carbon-main"><strong>{measured ? grams(s.carbon!.flights.meanSci) : '—'}</strong><span>CO₂e per change shipped</span></div>
              <div className="home-carbon-avoided"><strong>{measured ? pct(s.carbon!.flights.avoidedPct) : '—'}</strong><span>of pipeline emissions avoided</span><svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true"><path d="M8 7v16m0 0-5-5m5 5 5-5M21 4v22" stroke="currentColor" strokeWidth="1.3" /></svg></div>
            </div>
          </article>
        </div>
      </section>

      <section className="home-platform">
        <div className="home-wrap">
          <div className="home-section-heading"><p className="home-eyebrow">03 / The crew</p><h2>One crew.<br /><span>A shared view of delivery.</span></h2><p>Explore the roles behind each change. GitLab Duo flow definitions connect planning, repair and incident review to the same tower.</p></div>
          <div className="home-flows">
            {FLOWS.map((flow, i) => <article key={flow.name}><span className="home-flow-trigger"><span>{String(i + 1).padStart(2, '0')}</span>{flow.trigger}</span><h3>{flow.name}<Arrow diagonal /></h3><p>{flow.description}</p></article>)}
          </div>
          <div className="home-platform-note"><span className="home-label">Tower MCP server</span><p>Agents call <code>assess_change</code> before they write, keeping the plan within the autonomy they have earned.</p></div>
        </div>
      </section>

      <section className="home-final">
        <div><p className="home-eyebrow">Your airspace is waiting</p><h2>Ready to take<br /><span>the controls?</span></h2></div>
        <a className="home-button" href="/tower" onClick={go('/tower')}>Enter the tower <Arrow /></a>
      </section>

      <footer className="home-footer"><Wordmark /><span>MIT licensed · Designed for clarity</span><a href="#home-title">Back to top ↑</a></footer>
    </div>
  );
}
