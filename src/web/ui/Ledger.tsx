// The trust ledger: what each pilot has earned.

import type { AgentView } from '../../tower/store.ts';
import type { PolicySummary } from '../state.ts';
import { Empty, PilotMark } from './bits.tsx';
import { pct } from './format.ts';

export function Ledger({ agents, policy, simulated }: { agents: AgentView[]; policy: PolicySummary | null; simulated: boolean }) {
  const min = policy?.autonomous.minTrust ?? 0.55;
  return (
    <div className="ledger">
      <p className="lede">
        Autonomy is earned flight by flight. Each pilot’s trust is the conservative lower bound of their landing record, so three lucky flights don’t count like forty.
        {simulated && <span className="muted"> History below is seeded for the simulation.</span>}
      </p>
      {agents.length === 0 ? (
        <Empty>No flights recorded yet. Every pilot starts from the same sceptical prior.</Empty>
      ) : (
        <ul className="ledger-list">
          {agents.map((a) => (
            <li key={a.pilot} className={`ledger-row${a.autonomyEarned ? ' is-earned' : ''}`}>
              <div className="ledger-top">
                <PilotMark name={a.pilot} />
                <span className="ledger-trust mono">{pct(a.trust)}</span>
              </div>
              <div className="trust-track" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={a.trust} aria-label={`Trust for ${a.pilot}`}>
                <span className="trust-fill" style={{ width: pct(a.trust) }} />
                <span className="trust-mean" style={{ left: pct(a.mean) }} title={`Mean ${pct(a.mean)}`} />
                <span className="trust-threshold" style={{ left: pct(min) }} />
              </div>
              <div className="ledger-facts small">
                <span>{a.flights} flight{a.flights === 1 ? '' : 's'}</span>
                <span>{a.landed} landed</span>
                <span className={a.goArounds + a.incidents > 0 ? 'warn' : ''}>{a.goArounds + a.incidents} went around</span>
                <span>{a.streak} clean in a row</span>
                <span className="ledger-status">{a.autonomyEarned ? 'Flies autonomously' : `${a.needs === Infinity ? 'many' : a.needs} more clean landings to fly autonomously`}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <details className="method">
        <summary>How trust is computed</summary>
        <p className="small">
          Trust is the 90% lower bound of a Beta belief about clean landings. It starts at Beta(2, 3), so new agents are distrusted. A landing adds 0.5 + risk to the successes, so harder flights earn more. A go-around adds 1.5 − risk to the failures, so failing an easy flight costs more. An incident after promotion counts double. Flights decay with a 30-day half-life. The marker on each bar is the threshold for autonomy ({pct(min)}), and the thin line is the mean.
        </p>
      </details>
    </div>
  );
}
