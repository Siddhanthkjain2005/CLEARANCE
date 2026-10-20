# Clearance — project status

Last reviewed: 20 October 2026.

The owner reports that the project has been submitted. The public entry URL and external confirmation are not stored in this repository; local verification does not query submission status.

## Published experience

| Item | State | Reference |
|---|---|---|
| Source repository | Public, MIT licensed | [GitHub](https://github.com/Siddhanthkjain2005/CLEARANCE) |
| Hosted interface | Available with labelled simulated traffic | [Live app](https://clearance-tower-30123867341.northamerica-northeast1.run.app/) |
| Landing page and 3D airspace | Implemented | [Source](../../src/web/), [screenshots](../images/) |
| Search, filters, flight details and camera views | Implemented | [Airspace](https://clearance-tower-30123867341.northamerica-northeast1.run.app/tower) |
| Trust, Carbon and Governor views | Implemented | [Design case study](../design-case-study.md) |
| Design explanation and project narrative | Available | [Case study](../design-case-study.md), [project story](project-story.md) |
| Presentation scripts | Available | [Short tour](../demo/script.md), [complete walkthrough](../demo/website-walkthrough.md) |
| Types, tests, build, budget, links and HTTP/MCP checks | Reproducible | [Latest local report](../proof/readiness.json) |
| Public deployment checks | Recorded separately from local checks | [Deployment report](../proof/cloud-deployment.json) |

## Evidence boundaries

- The preview's flight traffic, agent actions and illustrative evidence badges are simulated.
- Local integration artifacts use a mock GitLab API and seeded trust history. They verify implementation behavior rather than live agent activity.
- SCI figures are modelled. They exclude LLM inference and browser GPU energy and do not prove measured production savings.
- The recorded browser review covers its identified snapshot. No formal user study or complete accessibility conformance audit has been conducted.
- The repository's optional GitLab flows and live delivery integrations require separate configuration and validation. They are not prerequisites for exploring the published interface.

## Further product work

1. Conduct task-based usability sessions for finding a held flight and understanding its clearance.
2. Complete keyboard, screen-reader, contrast, text-zoom and mobile-device reviews.
3. Measure rendering performance on lower-powered hardware.
4. Connect and validate real GitLab workflows if a live operational deployment is needed.

See the [maintainer handoff](maintainer-handoff.md) for integration and owner-review details.
