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

Before submitting, add links to actual GitLab issues, Duo sessions, merge requests, pipelines, releases and incidents in [the submission status](../hackathon/submission-status.md), then record those real runs in the final video.
