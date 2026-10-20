---
name: clearance-flight-planning
description: Plan a change so the Clearance governor can clear it autonomously. Use before implementing any issue in this repository, or when asked why a merge request was held or supervised.
metadata:
  slash-command: enabled
---

# Flight planning for Clearance

Clearance scores every change and decides how much autonomy it gets. Plan so the change earns the most autonomy it safely can.

## 1. Find the sectors you will touch

Read `.clearance/airspace.yml`. Each path belongs to the first sector that matches. Criticality runs from 0.02 (docs) to 1.0 (governance). Touching one low-criticality sector is the cheapest flight.

## 2. Predict the clearance

```shell
node src/cli/clearance.ts predict --pilot ai-clearance-dispatch \
  --files src/web/ui/Strip.tsx:40:8,test/strip.test.ts:30:0
```

Each file is `path:linesAdded:linesRemoved`. Add `--json` for machine-readable output. The governor reads the real trust ledger when a GitLab token is available, otherwise it starts every pilot from the sceptical prior.

## 3. Rescope until it is autonomous, or explain why it can't be

| Signal | How to lower it |
|---|---|
| Sector criticality | Keep the change in the least critical sector that can satisfy the intent. |
| Change size | Split large work into several flights. Each lands faster. |
| Blast radius | One runtime sector per flight. |
| Test gap | Add or update tests next to the code: about half as many test lines as shipped lines removes the signal. |
| Dependency change | Avoid touching `package.json` and the lockfile; ask a human. |
| Irreversible change | Migrations always fly supervised. Say so in the plan. |

Never plan changes to `.clearance/`, `.gitlab/duo/`, `.gitlab/security-policies/` or `CODEOWNERS`. Those are held for a human regardless of trust.

## 4. Write the flight plan

Start the issue note with `<!-- clearance:flight-plan -->`, then give the goal in one sentence, the files with the intent for each, acceptance criteria as a checklist, the test plan, and the predicted clearance with its risk percentage.
