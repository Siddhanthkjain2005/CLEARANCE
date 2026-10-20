# Maintainer handoff

## Published project

- [GitHub source and verification workflow](https://github.com/Siddhanthkjain2005/CLEARANCE).
- [Hosted interface](https://clearance-tower-30123867341.northamerica-northeast1.run.app/) on Cloud Run in `clearance-tower-20261020`.
- [Design case study](../design-case-study.md), [project story](project-story.md) and [presentation scripts](../demo/script.md).

The hosted interface runs in simulated mode. It can be explored without a GitLab account or cloud setup. The owner reports an external submission; its public entry URL has not been recorded here.

## Local maintenance

Use Node.js 22.18 or newer, run `npm ci`, then `npm run dev`. Run `node scripts/check-readiness.ts` before publishing changes. The report covers local engineering checks, while [cloud-deployment.json](../proof/cloud-deployment.json) records hosted endpoint verification separately.

The [deployment guide](../deployment.md) documents the current service and resource bounds. The existing GitHub workflow verifies changes; it does not deploy them automatically.

## Optional live GitLab integration

1. Choose a GitLab project where the necessary CI and Duo capabilities are available.
2. Review `node scripts/gitlab-setup.ts --project <group>/<project>` before applying settings. Add the CI variables from [setup.md](../setup.md) through the platform's secret settings.
3. Configure flow permissions, triggers, owner bindings and protected branches with the project owner.
4. Configure the Tower's read credential, webhook secret and CI event token. Keep credentials outside source control.
5. Validate a real intent, merge request, pipeline and release before describing the integration as operational. Retain actual session and pipeline links with the integration's evidence.

Keep `CLEARANCE_GCP_ENABLED` unset or false until GitLab CI identity and the cloud variables are configured. The default canary drill uses synthetic probes. A public Tower alone does not establish live GitLab connectivity.

## Owner review of protected files

Repository instructions protect `.clearance/`, `.gitlab/duo/`, `.gitlab/security-policies/` and CODEOWNERS. Product presentation updates do not change those policies or bindings.

- In `.gitlab/CODEOWNERS`, the placeholder `@clearance-maintainers` requires review against actual membership.
- In `.gitlab/duo/mcp.json`, `https://YOUR-TOWER-URL/mcp` requires the intended endpoint and appropriate client authentication.
- Validate custom flow definitions against the actual GitLab server and account capabilities.

Changes to those protected bindings belong in explicit owner review. Preserve genuine trust history and distinguish local fixtures from live outcomes.
