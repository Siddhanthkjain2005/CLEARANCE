# Verification evidence

Run from the repository root using Node 22.18 or newer:

```sh
npm ci
node scripts/check-readiness.ts
```

The command checks TypeScript, all tests, the production build, the existing 160 KiB gzip budget, documentation links, and the Tower's HTTP/MCP smoke checks. It writes `docs/proof/readiness.json` and full logs in `.clearance-out/readiness/`.

The integration tests also export `local/summary.json`, canary and SCI reports, and mock package-registry artifacts. That rehearsal runs the actual CLI against a local GitLab API fixture and deterministic canary probes. It verifies an auto-merge request, successful release, governance hold, rollback/incident, and a signed evidence chain.

These files are **local test evidence**. GitLab is mocked, trust history is a seeded fixture, and no Duo agent or Cloud Run revision runs in this rehearsal. They must not be labelled as real agent sessions, public pipeline history, measured production savings, or earned live trust.

The latest readiness run passed 135 tests. `browser-qa.json` records the desktop and 375-pixel mobile review. Current screenshots are in `docs/images/*.jpg`.

Optional live GitLab integration requires its own issue, Duo session, MR, pipeline, release and incident evidence. Those checks are separate from reviewing the published interface. See [project status](../presentation/project-status.md), the [design case study](../design-case-study.md) and the [product walkthrough](../demo/script.md) for the current experience and its evaluation limits.

The readiness report assesses local engineering behavior only. It does not determine account access, usability outcomes, accessibility conformance or external submission status.
