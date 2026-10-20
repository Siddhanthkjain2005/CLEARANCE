# Cloud deployment

[Open Clearance](https://clearance-tower-30123867341.northamerica-northeast1.run.app/)

The public interface runs on Google Cloud Run with simulated delivery traffic.

## Hosted service

| Setting | Value |
|---|---|
| Project | `clearance-tower-20261020` |
| Region | `northamerica-northeast1` |
| Service | `clearance-tower` |
| Revision | `clearance-tower-r47ecdf7766fd` |
| Image digest | `sha256:d5e0147bad1d894b31683aa573c48e663149319a41b1eb45187705313b157cb3` |
| Capacity | Minimum 0, maximum 1 instance |
| Resources | 1 CPU, 512 MiB, request-based CPU allocation |
| Request timeout | 300 seconds |

Cloud Build produces the container image, Artifact Registry stores it, and Cloud Run deploys the immutable digest. The runtime identity is separate from the build identity.

## Service checks

- [Health](https://clearance-tower-30123867341.northamerica-northeast1.run.app/api/health) returns service status, mode and revision.
- [State](https://clearance-tower-30123867341.northamerica-northeast1.run.app/api/state) provides the console snapshot and data mode.
- The app serves hashed, compressed assets with a Content Security Policy.
- Server-sent events deliver updates to the console.
- Event and webhook writes require their configured authentication.

## Deploy a separate instance

The deployment helper prints its target and commands for review:

```sh
node scripts/deploy-cloud-run.ts --project YOUR_GCP_PROJECT_ID --simulated
```

For a connected GitLab instance:

```sh
node scripts/deploy-cloud-run.ts \
  --project YOUR_GCP_PROJECT_ID \
  --gitlab-project YOUR_GROUP/YOUR_PROJECT
```

Add `--apply` after reviewing the command plan. The helper requests 1 CPU, 512 MiB, minimum 0 and maximum 2 instances. Cloud usage is billed according to the target project's configuration.

Connected deployments use a runtime service account and Secret Manager references for the GitLab read token, webhook secret and Tower event token. Follow [GitLab setup](setup.md) for variables, webhooks and workload identity. [Terraform](../infra/terraform/main.tf) and [CI deployment jobs](../.gitlab/ci/deploy.yml) provide the infrastructure and canary workflow.

After deployment, check `/api/health`, confirm the intended mode in `/api/state`, and verify that the console receives events from the configured source.
