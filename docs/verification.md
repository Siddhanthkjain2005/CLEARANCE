# Verification

Clearance verifies the decision engine, rendering geometry, integration behavior and production build through a reproducible local sequence and [GitHub CI](https://github.com/Siddhanthkjain2005/CLEARANCE/actions/workflows/ci.yml).

## Run the complete sequence

Use Node.js 22.18 or newer:

```sh
npm ci
node scripts/check-readiness.ts
```

| Check | Coverage |
|---|---|
| TypeScript | Console, Tower, CLI and decision-engine types |
| Tests | Risk, trust, governor, canary, evidence, SCI, geometry and integration behavior |
| Production build | Browser assets and hashed entry points |
| Bundle budget | JavaScript, CSS and HTML within 160 KiB gzip |
| Documentation | Relative links resolve |
| HTTP/MCP smoke checks | Server endpoints and protocol responses |

The 20 October 2026 verification passed **135 tests**. The production JavaScript, CSS and HTML total approximately **146 KiB gzipped**.

## Local reports

The complete runner saves its summary to `.clearance-out/readiness/report.json`, logs beside it, and integration fixtures under `.clearance-out/readiness/integration/`. These generated files are excluded from version control.

The integration suite uses an in-memory GitLab API and deterministic canary drills to exercise assessment, merge gating, a successful release, governance holds, rollback/incident handling and signed evidence. Fixture records include their provenance.

## Individual checks

```sh
npm run typecheck
npm test
npm run build
node src/cli/clearance.ts budget dist/web
node src/cli/clearance.ts doccheck
npm run test:smoke
```

The [architecture guide](architecture.md) describes the tested components. The [deployment guide](deployment.md) provides the public service health and state endpoints.
