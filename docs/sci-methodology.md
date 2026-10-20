# Carbon methodology

Clearance measures the carbon cost of delivery with the Green Software Foundation's **Software Carbon Intensity** specification (SCI, ISO/IEC 21031:2024), and reduces it through the way the pipeline is built. This document covers the formula, the coefficients and their sources, a worked example, how the savings are produced, and what the numbers don't capture.

## Functional unit

**R = one change shipped to production** (one "flight"). It answers the question a delivery team can act on: *what did it cost the planet to take this change from intent to production?* Taxi flights, meaning changes with nothing to deploy such as docs-only changes, count as flights too, because they still need verifying.

## Formula

```
SCI = ((E × I) + M) / R
```

| Term | Meaning | How Clearance computes it |
|---|---|---|
| E | Energy used by the pipeline jobs for the flight (kWh) | For each job: duration × (vCPU × (P_idle + u × (P_max − P_idle)) + memory × P_mem) × PUE |
| I | Grid carbon intensity where the jobs ran (gCO₂e/kWh) | Google Cloud's published location-based intensity for the region |
| M | Embodied emissions of the hardware share used (gCO₂e) | Server embodied emissions × (job time ÷ server lifetime) × (vCPUs used ÷ host vCPUs) |
| R | One change shipped | — |

Job durations come from the GitLab API (`/pipelines/:id/jobs`, including child pipelines through bridges) when a `CLEARANCE_TOKEN` is available. Otherwise they are typical durations recorded in the job catalog. Implementation: [`src/core/sci.ts`](../src/core/sci.ts), tested in [`test/sci-pipeline.test.ts`](../test/sci-pipeline.test.ts).

## Coefficients

| Coefficient | Value | Source |
|---|---|---|
| P_idle per vCPU | 0.71 W | Cloud Carbon Footprint (CCF), Google Cloud average minimum watts |
| P_max per vCPU | 4.26 W | CCF, Google Cloud average maximum watts |
| Utilisation u | 0.5 for CI jobs | CCF default assumption |
| P_mem | 0.392 W per GB (0.000392 kWh/GB·h) | CCF memory coefficient |
| PUE | 1.1 | CCF for Google Cloud |
| Server embodied emissions | 1,216 kgCO₂e | CCF base server estimate |
| Server lifetime | 4 years (35,040 h) | CCF |
| Host vCPUs | 64 | Assumption for the share calculation |
| GitLab.com hosted runner (small) | 2 vCPU, 8 GB | GitLab hosted runner specification |
| Runner region | `us-east1`, 579 gCO₂e/kWh | GitLab.com hosted runners run on Google Cloud; intensity from Google's 2025 data |
| Tower region | `northamerica-northeast1`, 11 gCO₂e/kWh, 97% CFE | [Google Cloud region carbon data](https://cloud.google.com/sustainability/region-carbon), 2025 |

All regional figures are in `GRID_INTENSITY` and `REGION_CFE`, and all coefficients are in `COEFFICIENTS`, so a team can override them with their own measurements. Set `CLEARANCE_RUNNER_REGION` if your runners live elsewhere.

### Check: one hour on a small runner

```
cpu    = 2 × (0.71 + 0.5 × (4.26 − 0.71))   = 4.97 W
memory = 8 × 0.392                          = 3.136 W
E      = (4.97 + 3.136) × 1.1 × 1 h         = 8.917 Wh = 0.008917 kWh
E × I  = 0.008917 × 579                     = 5.16 gCO₂e
M      = 1,216,000 × (1 / 35,040) × (2 / 64) = 1.08 gCO₂e
```

The test suite asserts the energy figure to six decimal places.

## Worked example: the same pipeline at four risk tiers

Each flight runs a fixed core that never adapts: assessment, SAST, secret detection, container scanning, the image build and the gate. On top of that sits the verification tier the governor chose. All figures are per flight, on GitLab.com small runners in `us-east1`, using catalog durations:

| Tier | Typical change | Jobs | Energy | SCI | Avoided vs. always-full |
|---|---|---|---|---|---|
| lean | console tweak with tests, trusted pilot | 8 | 0.87 Wh | 0.61 g | 0.63 g (51%) |
| standard | API change, or a low-risk change from an agent still earning trust | 11 | 1.31 Wh | 0.92 g | 0.26 g (22%) |
| full | engine rewrite, infrastructure, dependency upgrade | 12 | 1.69 Wh | 1.18 g | 0 |

A docs-only *taxi* flight skips the image, container scan and canary entirely.

The **avoided** column is the emissions of the jobs a fixed pipeline, one that runs every check on every change, would have run but this flight didn't. Clearance records the avoided jobs at assessment time, prices them with the same model, and reports them in the MR metrics widget (`clearance_avoided_gco2e`) and in the console.

## Where the savings come from

1. **Risk-proportional verification.** The governor's tier generates the child pipeline. Low-risk flights run *test impact analysis*: only the tests that transitively import a changed module, worked out from the static import graph ([`src/core/impact.ts`](../src/core/impact.ts)). Anything that can't be placed in the graph widens to the full suite, so the shortcut never skips a test that matters. Security scanning is deliberately excluded from this optimisation.
2. **Carbon-aware placement.** The Tower is deployed to `northamerica-northeast1` at 11 gCO₂e/kWh, compared with 432 in `us-central1` and 579 in `us-east1`. `greenestRegion()` picks the cleanest region from any candidate list, and the Tower's MCP `carbon_report` tool exposes it to agents.
3. **Idle is nearly free.** Cloud Run runs with `cpu_idle = true` (CPU is allocated only while serving) and the image is distroless with zero runtime dependencies. The Artifact Registry repository deletes images older than 30 days.
4. **Bytes are energy.** The console is gzip-budgeted in CI (`clearance budget`). The 3D airspace is a hand-written WebGL2 renderer that draws in a handful of calls with no textures, rather than a general-purpose engine.
5. **Fewer wasted runs.** Duplicate branch pipelines are suppressed when a merge request exists. `interruptible` jobs are cancelled by newer commits. Taxi flights skip the image build and the canary.

## Runtime SCI for the Tower

The Tower also reports its own SCI per thousand requests from measured process CPU time (`process.cpuUsage()`), using the same coefficients for a 1 vCPU Cloud Run instance and the region's intensity. This is shown in the Carbon tab and returned by `/api/carbon`. It uses wall-clock uptime as the time base. That overstates usage under `cpu_idle`, where CPU isn't allocated between requests, so the figure is conservative.

## Limitations

- **Location-based, not market-based.** Google matches much of its consumption with carbon-free energy purchases. SCI deliberately uses location-based grid intensity, which reflects the physical grid.
- **Averages, not marginal intensity.** Annual averages are used. Time-of-day carbon awareness (running non-urgent jobs when the grid is cleanest) would need a live intensity feed and is future work.
- **Durations are measured, but power is modelled.** Without hardware counters on hosted runners, utilisation is assumed at 50%.
- **Model inference is not included.** The Duo agents' LLM inference runs on GitLab's AI gateway and isn't observable from the project, so it's outside the system boundary and reported as such.
- **Browser rendering is not included.** The 3D console uses the viewer's GPU. The current pipeline/server SCI reports do not measure that device energy and must not be presented as a complete lifecycle footprint.
- **Embodied share is coarse.** The host size and lifetime are CCF defaults.

These limits apply equally to the fixed-pipeline baseline, so the *relative* savings are more robust than the absolute numbers.
