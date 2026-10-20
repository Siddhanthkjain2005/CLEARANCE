# Devpost submission draft

Owner check before pasting: registration, live Duo runs, public GitLab pipeline history and the final video are still pending. The labelled Cloud Run visual preview is deployed. Use [submission-status.md](submission-status.md) to replace pending evidence with verified links. Do not describe local mock results as live execution.

**Name:** Clearance

**Tagline:** Every change asks for clearance. Autonomy is earned, flight by flight.

**Proposed path:** Path A — Start Fresh, provided the project was created for this event.

**Autonomy level:** Select the level demonstrated by the final real run. The implementation supports autonomous, supervised, assisted and hold decisions; Hands-off remains a demonstration target until a real issue-to-production loop completes without intermediate human actions.

## Inspiration

Teams can generate code quickly, yet still spend time deciding which agent changes are safe to review, merge and release. Blanket approval creates risk; blanket restriction removes the benefit of automation. We borrowed the idea of air traffic clearance: every change receives permission according to its risk, the pilot's track record and current operating conditions.

## What it does

Clearance combines GitLab Duo workflows with a deterministic delivery governor. Agents propose and implement changes. Code evaluates their risk and decides the permitted level of autonomy.

- Dispatch is a four-agent workflow for planning, implementation, independent inspection and bounded rework.
- The governor combines eight change-risk signals with a Bayesian trust score and the service's error budget.
- Verification follows risk: a small docs change receives a lean path while a core change receives broader testing. Security scanners remain part of the pipeline.
- Progressive delivery analyzes canary errors, latency and SLO burn. The failure path rolls traffic back, opens an incident and lowers the pilot's trust.
- Each flight produces a tamper-evident evidence chain, trust-ledger update and modelled Software Carbon Intensity report.
- The console maps the nine lifecycle stages to aircraft moving through an airport approach. It includes searchable flight strips, a governor playground, a trust ledger, carbon reporting and a fully modeled WebGL world.

The source represents plan, create, verify, package, secure, release, configure, monitor and govern. The final submission must link actual pipeline and agent-session evidence for the stages demonstrated.

## How we built it

The decision engine and Tower use dependency-free TypeScript running directly on Node 22. The repository includes three custom Duo flow definitions, an agent prompt, project instructions, an agent skill and an MCP server. GitLab CI configuration generates verification child pipelines and integrates security scans, releases and evidence packages. Terraform and deployment jobs target Google Cloud Run, Artifact Registry, Secret Manager and workload identity federation.

The browser uses React-compatible TSX rendered by Preact and a custom WebGL2 engine. Terrain, water, buildings, airport structures, aircraft, foliage, roads and vehicles are generated from repository source. The renderer includes shadows, water reflections and animated traffic. Replacing the browser renderer reduced the complete console from 207.2 to about 146.0 KiB gzipped while preserving the world and the existing 160 KiB budget.

## Validation and evidence

Run `node scripts/check-readiness.ts` to reproduce the current test count, TypeScript check, production build, transfer budget, link checks and HTTP/MCP smoke tests. Results are saved in `docs/proof/readiness.json`.

The local integration rehearsal runs the real CLI against an in-memory GitLab API and deterministic canary drills. It verifies the merge request gate, an auto-merge request, a successful release, a governance hold, a failed-canary incident and signed evidence. Its trust history is a seeded fixture. It does not execute GitLab Duo or deploy to Cloud Run.

Before submission, replace this paragraph with real issue, Duo session, MR, pipeline, release, incident and deployment links from the evidence register. Keep local and live evidence clearly labelled.

## Challenges

- The trust decision must remain deterministic even when the implementation is agentic.
- New agents begin supervised, so earned autonomy requires real successful-flight history.
- A safe rollback must preserve a usable evidence trail and reconstructible state.
- A detailed 3D interface must fit a small transfer budget and keep operational data usable on phones.
- Local flow lint cannot validate account permissions or prove the actual tools available on a GitLab server; those checks belong to the real integration run.

## Accomplishments

The local implementation combines risk-adaptive verification, bounded autonomy, statistical delivery checks and inspectable evidence in one workflow. The interface makes an abstract delivery process visible while keeping its policy decisions explainable.

## What we learned

Autonomy needs a measurable boundary and a reversible failure path. The most useful record is not simply whether a change merged, but why it was allowed, what was verified and what happened after release.

## What's next

Complete the live GitLab demonstration, measure actual pipeline durations and developer interventions, then explore per-sector trust and carbon-aware scheduling.

## Built with

GitLab Duo Agent Platform, GitLab CI/CD, Model Context Protocol, Google Cloud Run deployment code, Terraform, Node.js 22, TypeScript, React component API, Preact, esbuild, WebGL2 and Software Carbon Intensity methodology.

## Environmental prize — opt in only with measured run evidence

The implementation reports SCI per change shipped and compares risk-proportional verification with an always-full baseline. The methodology distinguishes measured job durations from catalogue estimates and models energy from public coefficients. LLM inference and browser GPU energy are outside the current reported boundary. Do not claim a measured percentage saving until actual GitLab pipeline results are available. Attach those results and the methodology when opting in.

## Required links to fill

- Public GitLab repository: pending.
- Visible successful and failure pipeline history: pending.
- Under-three-minute YouTube video: pending.
- Public Google Cloud URL and deployment code: pending; omit bonus claim until verified.
- Devpost entry: pending.
