// Software Carbon Intensity (Green Software Foundation, ISO/IEC 21031:2024):
//
//   SCI = ((E × I) + M) per R
//
//   E  energy consumed by the software (kWh)
//   I  location-based marginal-ish grid intensity (gCO2e/kWh)
//   M  embodied emissions of the hardware share used (gCO2e)
//   R  functional unit. For Clearance R = one change shipped to production
//      ("one flight"), so the number answers: what did it cost the planet to
//      get this change from intent to production?
//
// Energy uses the Cloud Carbon Footprint (CCF) methodology for Google Cloud:
// per-vCPU power interpolated between idle and max by utilisation, plus memory
// power, multiplied by the data-centre PUE. Coefficients are documented in
// docs/sci-methodology.md and can be overridden.

export interface RunnerProfile {
  vcpu: number;
  memoryGb: number;
}

export const RUNNER_PROFILES: Record<string, RunnerProfile> = {
  'saas-linux-small-amd64': { vcpu: 2, memoryGb: 8 },
  'saas-linux-medium-amd64': { vcpu: 4, memoryGb: 16 },
  'saas-linux-large-amd64': { vcpu: 8, memoryGb: 32 },
  'saas-linux-xlarge-amd64': { vcpu: 16, memoryGb: 64 },
  'cloud-run-1cpu': { vcpu: 1, memoryGb: 0.5 },
};

/**
 * Google Cloud grid carbon intensity by region, gCO2eq/kWh, 2025 data.
 * Source: https://cloud.google.com/sustainability/region-carbon
 */
export const GRID_INTENSITY: Record<string, number> = {
  'africa-south1': 641, 'asia-east1': 428, 'asia-east2': 489, 'asia-northeast1': 449, 'asia-northeast2': 299,
  'asia-northeast3': 359, 'asia-south1': 598, 'asia-south2': 473, 'asia-southeast1': 366, 'asia-southeast2': 588,
  'australia-southeast1': 468, 'australia-southeast2': 416, 'europe-central2': 499, 'europe-north1': 30,
  'europe-north2': 19, 'europe-southwest1': 96, 'europe-west1': 126, 'europe-west2': 109, 'europe-west3': 276,
  'europe-west4': 194, 'europe-west6': 21, 'europe-west8': 202, 'europe-west9': 16, 'europe-west10': 276,
  'europe-west12': 202, 'me-central1': 370, 'me-central2': 381, 'me-west1': 381, 'northamerica-northeast1': 11,
  'northamerica-northeast2': 74, 'northamerica-south1': 293, 'southamerica-east1': 73, 'southamerica-west1': 210,
  'us-central1': 432, 'us-central2': 417, 'us-east1': 579, 'us-east2': 391, 'us-east4': 343, 'us-east5': 343,
  'us-south1': 299, 'us-west1': 98, 'us-west2': 150, 'us-west3': 568, 'us-west4': 360,
};

/** Google's carbon-free energy share by region, 2025, same source. */
export const REGION_CFE: Record<string, number> = {
  'europe-north1': 0.98, 'europe-north2': 1, 'europe-west9': 0.96, 'northamerica-northeast1': 0.97,
  'europe-west6': 0.97, 'us-west1': 0.83, 'us-central1': 0.88, 'us-east1': 0.31, 'asia-south1': 0.2,
  'europe-west1': 0.79, 'us-east4': 0.57, 'us-south1': 0.83,
};

export const COEFFICIENTS = {
  minWattsPerVcpu: 0.71, // CCF, Google Cloud average idle
  maxWattsPerVcpu: 4.26, // CCF, Google Cloud average at 100%
  memoryWattsPerGb: 0.392, // CCF: 0.000392 kWh per GB-hour
  pue: 1.1, // Google Cloud fleet-wide PUE (CCF uses 1.1)
  embodiedKgPerServer: 1216, // CCF base server embodied emissions, kgCO2e
  serverVcpus: 64, // vCPUs on the host the share is taken from
  serverLifetimeHours: 4 * 8760, // 4-year amortisation
  defaultUtilisation: 0.5,
};

export function gridIntensity(region: string): number {
  return GRID_INTENSITY[region] ?? 475; // IEA 2023 world average when unknown
}

export function energyKwh(durationSec: number, profile: RunnerProfile, utilisation = COEFFICIENTS.defaultUtilisation): number {
  const c = COEFFICIENTS;
  const cpuW = profile.vcpu * (c.minWattsPerVcpu + utilisation * (c.maxWattsPerVcpu - c.minWattsPerVcpu));
  const memW = profile.memoryGb * c.memoryWattsPerGb;
  return ((cpuW + memW) * c.pue * (durationSec / 3600)) / 1000;
}

export function embodiedG(durationSec: number, profile: RunnerProfile): number {
  const c = COEFFICIENTS;
  return c.embodiedKgPerServer * 1000 * (durationSec / 3600 / c.serverLifetimeHours) * (profile.vcpu / c.serverVcpus);
}

export interface JobFootprintInput {
  name: string;
  durationSec: number;
  runner?: string;
  utilisation?: number;
  status?: 'success' | 'failed' | 'skipped' | 'avoided' | 'canceled' | 'running' | 'manual' | 'created' | 'pending';
}

export interface JobFootprint extends JobFootprintInput {
  energyKwh: number;
  operationalG: number;
  embodiedG: number;
  totalG: number;
}

export interface SciReport {
  region: string;
  intensity: number;
  functionalUnit: string;
  jobs: JobFootprint[];
  energyKwh: number;
  operationalG: number;
  embodiedG: number;
  sci: number; // gCO2e per functional unit
  baselineG: number; // what an always-full pipeline would have emitted
  avoidedG: number;
  avoidedPct: number;
}

const r = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export function footprint(job: JobFootprintInput, region: string): JobFootprint {
  const profile = RUNNER_PROFILES[job.runner ?? 'saas-linux-small-amd64'] ?? RUNNER_PROFILES['saas-linux-small-amd64'];
  const e = energyKwh(job.durationSec, profile, job.utilisation);
  const op = e * gridIntensity(region);
  const em = embodiedG(job.durationSec, profile);
  return { ...job, energyKwh: r(e, 6), operationalG: r(op), embodiedG: r(em), totalG: r(op + em) };
}

/**
 * Computes SCI for one flight. `ran` are the jobs that actually executed;
 * `avoided` are the jobs a fixed, always-full pipeline would also have run,
 * with their typical durations. Their emissions are reported as savings.
 */
export function sciForFlight(ran: JobFootprintInput[], avoided: JobFootprintInput[], region: string, flights = 1): SciReport {
  const jobs = ran.map((j) => footprint(j, region));
  const skipped = avoided.map((j) => footprint({ ...j, status: 'avoided' }, region));
  const energy = jobs.reduce((a, j) => a + j.energyKwh, 0);
  const op = jobs.reduce((a, j) => a + j.operationalG, 0);
  const em = jobs.reduce((a, j) => a + j.embodiedG, 0);
  const avoidedG = skipped.reduce((a, j) => a + j.totalG, 0);
  const total = op + em;
  return {
    region,
    intensity: gridIntensity(region),
    functionalUnit: 'one change shipped to production',
    jobs: [...jobs, ...skipped],
    energyKwh: r(energy, 6),
    operationalG: r(op),
    embodiedG: r(em),
    sci: r(total / Math.max(1, flights)),
    baselineG: r(total + avoidedG),
    avoidedG: r(avoidedG),
    avoidedPct: total + avoidedG === 0 ? 0 : r(avoidedG / (total + avoidedG), 4),
  };
}

/** Runtime SCI for a service: gCO2e per 1,000 requests from measured CPU time. */
export function runtimeSci(cpuSeconds: number, wallSeconds: number, requests: number, region: string, profile: RunnerProfile = RUNNER_PROFILES['cloud-run-1cpu']) {
  const util = wallSeconds > 0 ? Math.min(1, cpuSeconds / (wallSeconds * profile.vcpu)) : 0;
  const e = energyKwh(wallSeconds, profile, util);
  const g = e * gridIntensity(region) + embodiedG(wallSeconds, profile);
  return {
    utilisation: r(util),
    energyKwh: r(e, 8),
    totalG: r(g, 6),
    perThousandRequests: requests > 0 ? r((g / requests) * 1000, 6) : 0,
  };
}

/** Picks the lowest-carbon region from candidates, for carbon-aware placement. */
export function greenestRegion(candidates: string[]): { region: string; intensity: number } {
  return candidates
    .map((region) => ({ region, intensity: gridIntensity(region) }))
    .sort((a, b) => a.intensity - b.intensity)[0];
}
