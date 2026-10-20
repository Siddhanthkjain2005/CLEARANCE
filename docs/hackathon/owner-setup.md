# Account and owner handoff

The local package is prepared for publication. These steps require the owner's accounts or permissions and cannot be completed from an unsigned-in local folder.

1. Sign in to [Devpost](https://gitlab-transcend.devpost.com/) and join Life After Code. Complete any eligibility declarations or terms yourself.
2. Sign in to [GitLab contributor onboarding](https://contributors.gitlab.com/transcend-hackathon), complete its security check, and provide your Devpost username. GitLab publishes an approval estimate of about 24 business hours.
3. Provide the provisioned project URL. Add it as `origin`, push `main`, and verify the project is public with its MIT license and visible CI/CD history.
4. Review the project settings preview from `node scripts/gitlab-setup.ts --project <group>/<project> --public`. Applying it requires a suitable token in the terminal environment, not chat.
5. Add the CI variables from [setup.md](../setup.md), enable the three flows and their triggers, then run the first supervised intent. Review owner permissions before allowing a service account to merge into the default branch.
6. The owner requested cloud deployment on 20 October. A labelled visual preview is now deployed in the separate `clearance-tower-20261020` project. See [deployment.md](../deployment.md) for the public URL, configuration and verification. Live GitLab credentials and webhook integration remain pending.
7. Leave `CLEARANCE_GCP_ENABLED` unset or false until GitLab CI identity, cloud variables and live credentials are configured. The existing pipeline selects `monitor:canary-drill`, which uses synthetic probes; record it as a drill. The public Tower is reachable, but its preview has no GitLab credential, event token or webhook secret configured. Real GitLab pipeline and Duo evidence are still required.
8. Record the real evidence links and final YouTube URL in [submission-status.md](submission-status.md), then complete and submit the Devpost form.

## Owner review of protected files

Repository instructions protect `.clearance/`, `.gitlab/duo/`, `.gitlab/security-policies/` and CODEOWNERS. Their policy content has not been changed during readiness work.

- In `.gitlab/CODEOWNERS`, replace the placeholder `@clearance-maintainers` with the actual owner/group after verifying membership.
- In `.gitlab/duo/mcp.json`, replace `https://YOUR-TOWER-URL/mcp` with the deployed endpoint and configure authentication as appropriate for the Duo client.
- Validate each custom flow in the actual GitLab UI and check that the account has the required tools and triggers.

These bindings are intentionally explicit owner review items. Do not weaken governance or edit trust history to make a demonstration appear hands-off.
