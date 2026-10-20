// Carbon: Software Carbon Intensity per change shipped, and what the
// risk-adaptive pipeline avoided.

import type { FlightView } from '../../core/projection.ts';
import { GRID_INTENSITY } from '../../core/sci.ts';
import type { Carbon as CarbonData } from '../state.ts';
import { Empty } from './bits.tsx';
import { grams, pct } from './format.ts';

const REGIONS = ['us-east1', 'us-central1', 'europe-west1', 'us-west1', 'europe-north1', 'northamerica-northeast1'];
const REGION_NAMES: Record<string, string> = {
  'us-east1': 'South Carolina', 'us-central1': 'Iowa', 'europe-west1': 'Belgium', 'us-west1': 'Oregon', 'europe-north1': 'Finland', 'northamerica-northeast1': 'Montréal',
};

export function Carbon({ carbon, flights }: { carbon: CarbonData | null; flights: FlightView[] }) {
  const withSci = flights.filter((f) => f.sci).slice(0, 12).reverse();
  const max = Math.max(0.001, ...withSci.map((f) => f.sci!.sci + f.sci!.avoidedG));
  const maxI = Math.max(...REGIONS.map((r) => GRID_INTENSITY[r]));
  const c = carbon?.flights;
  return (
    <div className="carbon">
      <div className="carbon-hero">
        <div>
          <span className="big mono">{c && c.flights ? grams(c.meanSci) : '–'}</span>
          <span className="muted small">CO₂e per change shipped</span>
        </div>
        <div>
          <span className="big mono">{c && c.flights ? pct(c.avoidedPct) : '–'}</span>
          <span className="muted small">of pipeline emissions avoided</span>
        </div>
      </div>
      <p className="small">
        SCI = (E × I + M) per R, where R is one change taken from intent to production. Energy follows the Cloud Carbon Footprint coefficients for Google Cloud, grid intensity is Google’s published 2025 figure for the runner’s region, and M amortises the server’s embodied emissions.
      </p>
      <h4 className="mini-head">Recent flights</h4>
      {withSci.length === 0 ? (
        <Empty>Carbon is reported when a flight reaches Govern.</Empty>
      ) : (
        <ul className="sci-bars">
          {withSci.map((f) => (
            <li key={f.id}>
              <span className="mono small">{f.id}</span>
              <span className="sci-track">
                <span className="sci-used" style={{ width: `${(f.sci!.sci / max) * 100}%` }} />
                <span className="sci-avoided" style={{ width: `${(f.sci!.avoidedG / max) * 100}%` }} />
              </span>
              <span className="mono small">{grams(f.sci!.sci)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="legend small">
        <span className="legend-item"><span className="key key-used" /> Emitted</span>
        <span className="legend-item"><span className="key key-avoided" /> Avoided by skipping jobs the change could not affect</span>
      </div>

      <h4 className="mini-head">Where the work runs</h4>
      <ul className="region-bars">
        {REGIONS.map((r) => (
          <li key={r} className={r === carbon?.runtime.region ? 'is-current' : ''}>
            <span className="small">{REGION_NAMES[r]} <span className="muted mono">{r}</span></span>
            <span className="region-track"><span className="region-fill" style={{ width: `${(GRID_INTENSITY[r] / maxI) * 100}%` }} /></span>
            <span className="mono small">{GRID_INTENSITY[r]} g/kWh</span>
          </li>
        ))}
      </ul>
      {carbon?.runtime && (
        <p className="small muted">
          The Tower itself runs in {carbon.runtime.region} at {carbon.runtime.intensity} g/kWh and currently costs {carbon.runtime.perThousandRequests.toFixed(3)} g CO₂e per thousand requests (measured CPU {pct(carbon.runtime.utilisation, 1)}).
        </p>
      )}
    </div>
  );
}
