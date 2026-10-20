# Clearance submission status

Last reviewed: 20 October 2026. Target: [Life After Code](https://gitlab-transcend.devpost.com/), Path A if the work was created for this event. The Devpost schedule lists the deadline as 27 October 2026 at 13:00 UTC / 18:30 IST. Aim to submit on 26 October.

## Local preparation

| Item | Status | Evidence |
|---|---|---|
| Risk governor, trust, canary, evidence and SCI implementation | Implemented; locally tested | `src/core/`, `test/` |
| Production bundle | 146.0 KiB gzipped against the existing 160 KiB limit | Run `node scripts/check-readiness.ts` for current numbers |
| Complete 3D console | Implemented; simulated traffic is labelled | `src/web/` |
| Local successful release / hold / rollback rehearsal | Automated mock integration | `docs/proof/local/summary.json` after readiness run |
| TypeScript, tests, build, links and HTTP/MCP smoke checks | Reproducible | `docs/proof/readiness.json` after readiness run |
| Git repository | Prepared on `main` for GitHub publication | [Siddhanthkjain2005/CLEARANCE](https://github.com/Siddhanthkjain2005/CLEARANCE); hackathon GitLab project still pending |
| Submission description and demo narration | Drafted | [Submission text](devpost.md), [demo script](../demo/script.md) |

## Required external work

| Item | Current state | Completion evidence |
|---|---|---|
| Devpost account and event registration | Owner sign-in required | Joined event and saved project draft |
| GitLab hackathon onboarding | Safari sign-in confirmed; contributor authorization approved by owner, completion and organizer provisioning pending | Provisioned subgroup/project URL |
| Public repository with MIT license | Pending workspace | Public project link; source/assets and pipeline history visible |
| Duo Dispatch / Medic / Debrief | YAML exists; no real session run yet | Enabled triggers and successful session URLs |
| CI variables, owner bindings and branch permissions | Pending account/owner access | Green real pipeline; reviewed owner settings |
| Successful real lifecycle | Not run | Issue → MR → checks → release URLs |
| Canary failure and hold | Local tests only | Real pipeline/incident and held MR URLs |
| Public Cloud Run service | Deployed on 20 October in a separate project; labelled simulated traffic | [Public tower](https://clearance-tower-30123867341.northamerica-northeast1.run.app/tower), [verification](../proof/cloud-deployment.json); live GitLab integration pending |
| Under-three-minute video | Script ready; final live footage pending | Public or unlisted YouTube URL |
| Devpost submission | Not submitted | Submission confirmation |

## Live evidence register

- Public repository: pending.
- Intent issue: pending.
- Dispatch session: pending.
- Merge request and Inspector evidence: pending.
- Successful pipeline and release: pending.
- Failed-canary pipeline and incident: pending.
- Governance-hold example: pending.
- Public deployment: https://clearance-tower-30123867341.northamerica-northeast1.run.app/tower (simulated traffic; source-publication requirements for any bonus remain pending).
- Final video: pending.
- Devpost project: pending.

## Claims to check before publishing

- Choose Hands-off only after a real loop completes without intermediate human actions. Otherwise select the autonomy level actually demonstrated.
- Seeded test trust belongs only to local fixtures. Build real successful-flight history to demonstrate earned autonomy.
- Local mock artifacts and simulated traffic must remain labelled.
- SCI power is modelled, job durations may be catalogue estimates, and LLM inference is excluded. Replace headline savings with results from actual GitLab runs before opting in for the environmental prize.
- Include the optional Google Cloud bonus only after the public deployment and its source are available to judges.

The final entry is not ready until the required external rows have evidence. The current account handoff is documented in [owner-setup.md](owner-setup.md).
