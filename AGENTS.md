# Working on Clearance as an agent

These are the rules for GitLab Duo agents (and anyone else) changing this repository. Clearance governs its own delivery, so every change you make is scored by the same risk model you are reading about here.

## What this project is

Clearance is a control tower for autonomous delivery. A deterministic governor weighs each change's risk against the autonomy its author has earned, then decides how far the change may fly without a human: autonomous, supervised, assisted or hold.

- `src/core/` is the decision engine: risk model, governor, trust ledger, canary statistics, SLO burn rates, carbon (SCI), evidence chain. Pure TypeScript with no dependencies.
- `src/cli/` is the `clearance` command the pipeline runs.
- `src/tower/` is the HTTP server: console, event stream, webhooks, MCP server.
- `src/web/` is the console: React plus a hand-written WebGL2 renderer.
- `.clearance/` holds the policy. It is protected.

## Commands

| Task | Command |
|---|---|
| Run all tests | `node --test "test/*.test.ts"` |
| Run one test file | `node --test test/risk.test.ts` |
| Predict a change's clearance | `node src/cli/clearance.ts predict --files src/web/ui/Strip.tsx:40:8,test/strip.test.ts:30:0` |
| Explain the current diff | `node src/cli/clearance.ts explain` |
| Smoke-test the server | `node test/smoke.ts` |
| Type-check (needs `npm install`) | `npx tsc --noEmit` |
| Build the console (needs `npm install`) | `npm run build:web` |

Node 22.18 or newer runs TypeScript directly, so most work needs no install step.

## Rules

1. **Never edit governance files.** `.clearance/`, `.gitlab/duo/`, `.gitlab/security-policies/` and `CODEOWNERS` are in the protected sector. The governor holds any agent change that touches them, every time. Propose such changes in an issue or a clearly labelled merge request for a human instead.
2. **Predict before you build.** Run `clearance predict` on your plan. If it isn't autonomous, rescope: split the change by sector, add tests next to shipped code, avoid dependency changes.
3. **Ship tests with code.** A change to shipped code without tests carries a test-gap risk signal. Don't delete or weaken tests to get green.
4. **Erasable TypeScript only.** No `enum`, no `namespace`, no constructor parameter properties. Node strips types without compiling, and import paths keep their `.ts` extension.
5. **No new runtime dependencies.** The Tower has zero. Dev dependencies need a human reviewer because `package.json` is a manifest the risk model weights.
6. **Conventional commits** (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`). The release job derives the version from them.
7. **Identify yourself.** End every commit message with a trailer naming the pilot, for example:
   ```
   Clearance-Pilot: ai-clearance-dispatch
   ```
   The trust ledger credits or debits that pilot for the outcome.
8. **Leave markers for the black box.** Flight plans start with `<!-- clearance:flight-plan -->`. Inspection notes start with `<!-- clearance:inspection verdict=CLEARED -->` or `verdict=CHANGES`. The gate copies them into the evidence chain.

## Code style

- Two-space indentation, single quotes, semicolons, trailing commas in multi-line literals.
- Explain *why* in comments, not what. Every module opens with a short paragraph on its purpose.
- User-facing text is plain, sentence-case English. Buttons say what they do.
- Keep functions pure in `src/core/`; side effects belong in `src/cli/` and `src/tower/`.

## How your change will be judged

The risk model scores eight signals: sector criticality, change size, blast radius, test gap, dependency changes, irreversible changes, critical deletions and security findings. They combine as independent causes: `risk = 1 − Π(1 − pᵢ)`. See `src/core/risk.ts` and `.clearance/airspace.yml`.
