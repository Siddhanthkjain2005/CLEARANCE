# Cloud Run deployment

Deployed on 20 October 2026 to a separate project selected by the owner.

- Public app: [Clearance tower](https://clearance-tower-30123867341.northamerica-northeast1.run.app/tower).
- Project: `clearance-tower-20261020`; region: `northamerica-northeast1`.
- Service: `clearance-tower`; revision: `clearance-tower-r6247c2ffeab2`.
- Mode: **simulated traffic**, explicitly labelled in the app. Live GitLab integration is still pending.
- Capacity: zero minimum and one maximum instance, one CPU, 512 MiB, request-based CPU billing, 300-second request timeout.
- Runtime identity: `clearance-tower@clearance-tower-20261020.iam.gserviceaccount.com`, created without cloud IAM roles.

The container was built in Cloud Build and deployed by immutable digest. The build identity can read the private source bucket, write the image repository and write build logs. The existing Amazon ML project and CLI default were not changed.

Seven public endpoint checks passed: health, simulated state, tower HTML/security headers, compressed production JavaScript, event stream, and rejected unauthenticated event/webhook writes. Browser inspection was unavailable because local browser use is disabled in Work settings. See [deployment evidence](proof/cloud-deployment.json) and [the exact build configuration](proof/cloud-build.json).

Cloud Run can scale to zero, but storage, builds and active requests can still incur charges. The instance limit is not a spending cap.

## Future deployments

The repository already includes [Terraform](../infra/terraform/main.tf) and [CI deployment jobs](../.gitlab/ci/deploy.yml). Follow [setup.md](setup.md) for workload identity and infrastructure. The helper below makes the initial source deployment explicit and defaults to a read-only command preview.

```sh
node scripts/deploy-cloud-run.ts \
  --project YOUR_GCP_PROJECT_ID \
  --gitlab-project gitlab-ai-hackathon/transcend-october-2026/YOUR_SUBGROUP/YOUR_PROJECT
```

The preview lists the exact target, public-service setting, resource bounds, required secrets and argv. It does not change the CLI default, create billing, create secrets or deploy resources.

## Before applying

- Confirm the target project and billing boundary. Enable Cloud Run, Cloud Build, Artifact Registry and Secret Manager APIs.
- Bootstrap the runtime identity and IAM with the existing Terraform or have the owner configure them. The helper expects `clearance-tower@PROJECT_ID.iam.gserviceaccount.com`.
- Create three Secret Manager secrets: `clearance-gitlab-token`, `clearance-webhook-secret`, and `clearance-tower-token`. Give the runtime identity access to those specific secrets. Never place their values in source or chat.
- Confirm that the GitLab token has the required read access to the hackathon project. Separate that read token from the CI write credential.
- Review that the app will be public. Deployment uses one CPU, 512 MiB, minimum zero and maximum two instances; these bounds limit scaling but do not guarantee a cost cap.

After reviewing the plan and prerequisites, add `--apply` to run it. Without live credentials, an explicitly labelled visual preview can use `--simulated`; that does not complete the live workflow proof.

## Verify completion

1. Read the service URL printed by the helper.
2. Confirm `GET /api/health` returns HTTP 200 and `ok: true`.
3. Confirm `GET /api/state` reports `server.mode: live`, the intended project and a successful GitLab sync with no current error.
4. Configure the webhook and CI event URL, then verify that a real issue/MR/pipeline appears in the console.
5. Record the real deployment URL and evidence links in [submission-status.md](hackathon/submission-status.md).

Keep the submitted deployment available through judging and the winner announcement. Freeze the submitted repository and video after the deadline; continue development on a separate copy.
