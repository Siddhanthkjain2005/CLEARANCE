# Setting up Clearance on GitLab

The [public interface](https://clearance-tower-30123867341.northamerica-northeast1.run.app/) and local simulated mode work without a GitLab account. This guide is for maintainers who want to connect actual issues, pipelines and agent workflows. It requires a GitLab project with suitable permissions and access to the relevant Duo capabilities.

| After step | You have |
|---|---|
| 2 | Pipeline configuration ready to validate on merge requests and `main`, with canary drills |
| 4 | Duo flow definitions and triggers ready for a real integration run |
| 5 | Console synchronization and webhook settings for your project |
| 6 | Cloud Run canary deployment configuration to validate |

## Before you start

- A GitLab project with a runner and permissions to configure CI/CD. Duo flows additionally require access to the GitLab Duo Agent Platform.
- Node.js 22.18 or newer locally.
- For step 6: a Google Cloud project with billing enabled and the `gcloud` CLI.

## 1. Push the code

```shell
cd clearance
npm ci                           # reproduce the checked dependency versions
node scripts/check-readiness.ts   # tests, types, build, bundle, docs, smoke and local proof
git remote add gitlab https://gitlab.com/<group>/<project>.git
git push gitlab main
```

The published repository is already initialized on `main` with GitHub as `origin`. Add a separate GitLab remote for the project you intend to configure.

Preview the repeatable project settings without making remote changes:

```shell
node scripts/gitlab-setup.ts --project <group>/<project> --public
```

After reviewing that plan, a project owner with the required API permissions can apply it with `--apply`. `CLEARANCE_TOKEN` must be supplied through the local terminal environment. The script never prints the token and does not change protected branches, CODEOWNERS, flow permissions or CI secrets.

Then in the project:

- **Settings > General > Visibility:** choose visibility appropriate for your project. `--public` in the helper explicitly requests a public project; omit it for no visibility change.
- **Settings > Merge requests:**
  - Turn on *Pipelines must succeed*. This is what makes a Clearance hold actually block a merge.
  - Turn on *Enable "Delete source branch" option by default*.
  - Turn on *merged results pipelines* if your tier offers it.
- **Settings > Repository > Protected branches:** for `main`, set *Allowed to merge* to *Developers + Maintainers*.
- **Manage > Labels:** create a label called `intent`. Clearance creates the rest itself (`clearance::*`, `risk::*`, `flight::*`) the first time it uses them.
- **CODEOWNERS:** replace `@clearance-maintainers` in [`.gitlab/CODEOWNERS`](../.gitlab/CODEOWNERS) with your usernames.

## 2. CI/CD variables

Have the project owner review **Settings > CI/CD > Variables** and add these. Mark secrets as *Masked* and *Hidden* where supported. Required MR jobs need access on the branches used for integration testing; scope that access deliberately. Never enable privileged secrets for unreviewed fork pipelines. Configuring tokens, protected branches and project settings may require a maintainer or owner.

| Variable | Value | Needed for |
|---|---|---|
| `CLEARANCE_TOKEN` | A **project access token** (Settings > Access tokens) with role *Maintainer* and scope `api` | MR notes, labels, auto-merge, approval rules, incidents, release updates |
| `CLEARANCE_SIGNING_KEY` | Any random string of 32+ characters (`openssl rand -hex 32`) | HMAC-signing evidence packs |

That's enough for the full pipeline. Push a commit or open a merge request and you'll see:

- `clearance:assess` scoring the change
- a generated child pipeline under `verify:flight`
- the four security scanners
- `clearance:gate` posting its decision on the merge request

On `main`, `monitor:canary-drill` runs the real canary statistics against a simulated target, then the trust ledger, evidence pack and carbon report follow.

To watch a go-around, run a pipeline on `main` (**Build > Pipelines > Run pipeline**) with the variable `CLEARANCE_DRILL` set to `errors` or `latency`.

## 3. Schedule the nightly audit

Go to **Build > Pipeline schedules > New schedule**, choose daily, target `main`. The `govern:audit` job re-verifies every black box's hash chain and prints the trust ledger.

## 4. Duo flows and agent

You create flows in GitLab's UI from the YAML files in this repository. Current GitLab versions expose project flows under **Automate > Agents** or through the AI Catalog; older versions use **AI > Flows**. Validate the YAML in GitLab itself before counting any flow as operational. Local flow lint checks structure but cannot prove which server-side tools are available.

### Dispatch: intent to merge request

1. Go to **AI > Flows > New flow**. Name it *Clearance Dispatch*, set visibility to *Private* and configuration to *Flow*. Paste [`.gitlab/duo/flows/clearance-dispatch.yml`](../.gitlab/duo/flows/clearance-dispatch.yml), then select **Create flow**.
2. On the **Managed** tab, select the flow, then **Enable**. Choose this project and add the triggers:
   - **Work item: Created.** Optional goal: *"Plan and implement this intent following AGENTS.md. Predict clearance before building."*
   - **Mention**, so you can rerun it by mentioning the service account on an issue.
3. Enabling the flow creates a service account named `ai-clearance-dispatch-<group>` and adds it to the project as a Developer.

### Medic: fix failed pipelines

Repeat with [`.gitlab/duo/flows/clearance-medic.yml`](../.gitlab/duo/flows/clearance-medic.yml) and the trigger **Pipeline events: Failed**.

### Debrief: postmortems

Repeat with [`.gitlab/duo/flows/clearance-debrief.yml`](../.gitlab/duo/flows/clearance-debrief.yml) and the trigger **Mention**. After a go-around, mention its service account on the incident Clearance opened.

### Tower agent (optional)

Go to **AI > Agents > New agent**, paste the system prompt from [`.gitlab/duo/agents/tower.md`](../.gitlab/duo/agents/tower.md) and enable the tools it lists. Then ask Agentic Chat *"why was !12 held?"*.

### Things to know

- Triggers need a human action, so creating the intent issue is the one human step. GitLab doesn't let a flow trigger another flow; the pipeline and the governor carry the work from merge request to production.
- Triggered flows bill GitLab Credits to the flow's service account.
- The flows run in the environment defined by [`.gitlab/duo/agent-config.yml`](../.gitlab/duo/agent-config.yml) (Node 22, so agents can run `clearance predict` and the tests). That file is read from `main` only.
- **New agents start supervised.** Their trust begins at the sceptical prior, and about nine clean landings earn hands-off clearance. Approve the first few supervised flights, and you'll watch the agent earn autonomy in the trust ledger. Each landing counts, and the ledger lives in the package registry (`clearance-ledger/v1/ledger.json`).

### MCP for Duo in the IDE and the CLI

[`.gitlab/duo/mcp.json`](../.gitlab/duo/mcp.json) points Duo at the Tower's MCP endpoint. Replace `YOUR-TOWER-URL` once you have one, or run `npm run dev` and use the `clearance-local` entry. Then ask Duo in VS Code: *"Use assess_change to tell me what clearance a 200-line change to src/core/governor.ts would get."*

To let the CI debrief job use the Duo CLI headlessly, add a masked `DUO_CLI_TOKEN` variable: a personal access token for a user with Duo access.

## 5. The live console

The Tower is the console and API. It runs anywhere Node 22 runs; step 6 deploys it to Cloud Run. Locally:

```shell
CLEARANCE_GITLAB_TOKEN=<read_api token> \
CLEARANCE_PROJECT=<group>/<project> \
CLEARANCE_WEBHOOK_SECRET=<random> \
CLEARANCE_TOWER_TOKEN=<random> \
npm run dev
```

| Environment variable | Purpose |
|---|---|
| `CLEARANCE_GITLAB_TOKEN`, `CLEARANCE_PROJECT` | Live mode: sync merge requests, pipelines, black boxes and the ledger from GitLab |
| `CLEARANCE_GITLAB_URL` | Defaults to `https://gitlab.com` |
| `CLEARANCE_WEBHOOK_SECRET` | Required for `/webhooks/gitlab` |
| `CLEARANCE_TOWER_TOKEN` | Required for CI to post events to `/api/events` |
| `CLEARANCE_MCP_TOKEN` | Optional bearer token for `/mcp` |
| `CLEARANCE_MODE` | `auto` (default), `live`, `simulated` or `both` |
| `CLEARANCE_REGION` | Region used for runtime carbon accounting |

Then:

- **Webhook:** go to **Settings > Webhooks**. Set the URL to `https://<tower>/webhooks/gitlab` and the secret token to `CLEARANCE_WEBHOOK_SECRET`. Select pipeline, job, merge request, issue, comment, deployment and release events.
- **CI variables:** set `CLEARANCE_TOWER_URL` to the Tower URL and `CLEARANCE_TOWER_TOKEN` to the same token, so jobs stream events as they happen.

## 6. Google Cloud — optional live canaries

### Existing hosted preview

The interface is already hosted on Cloud Run in simulated mode. See [deployment.md](deployment.md) for the explicit target, immutable image deployment and verification. Live canary integration is a separate setup; prefer the workload identity path below for CI authentication.

### Recommended path: workload identity federation and Terraform

1. **Identity.** Go to **Settings > Integrations > Google Cloud IAM > Guided setup** and follow the steps. It creates a workload identity pool and provider for your group, so jobs with `identity: google_cloud` authenticate without keys. Note the pool ID and the project number.
2. **Infrastructure.** [`infra/terraform`](../infra/terraform) creates:
   - the Artifact Registry repository, with cleanup policies
   - the Tower's runtime service account
   - Secret Manager secrets
   - the Cloud Run service (min 1 instance, CPU only while serving, startup boost, health probes)
   - public invoker access
   - the CI identity's roles

   State is stored in GitLab's managed Terraform state. Bootstrap it once from your machine:

   ```shell
   cd infra/terraform
   export GITLAB_PAT=<personal access token with api scope>
   STATE="https://gitlab.com/api/v4/projects/<PROJECT_NUMERIC_ID>/terraform/state/production"
   terraform init \
     -backend-config="address=$STATE" -backend-config="lock_address=$STATE/lock" -backend-config="unlock_address=$STATE/lock" \
     -backend-config="username=<your username>" -backend-config="password=$GITLAB_PAT" \
     -backend-config="lock_method=POST" -backend-config="unlock_method=DELETE"
   terraform apply \
     -var project_id=<PROJECT_ID> -var gitlab_project=<group>/<project> -var gitlab_project_id=<PROJECT_NUMERIC_ID> \
     -var wif_pool_project_number=<PROJECT_NUMBER> -var wif_pool_id=<POOL_ID> \
     -var gitlab_read_token=<read_api token> -var webhook_secret=<random> -var tower_token=<random>
   ```

   After that, the `configure:terraform` job plans on merge requests and applies on `main` whenever `infra/` changes.
3. **CI variables:**

   | Variable | Value |
   |---|---|
   | `CLEARANCE_GCP_ENABLED` | `true` |
   | `GOOGLE_CLOUD_PROJECT` | project ID |
   | `GOOGLE_CLOUD_PROJECT_NUMBER`, `GOOGLE_WIF_POOL_ID` | from step 1 |
   | `CLEARANCE_GITLAB_READ_TOKEN`, `CLEARANCE_WEBHOOK_SECRET`, `CLEARANCE_TOWER_TOKEN` | the same values you gave Terraform (masked) |
   | `CLEARANCE_TOWER_URL` | the `tower_url` output |

4. **First deployment.** Run a pipeline on `main`. The `configure:image` job copies the image into Artifact Registry, and `monitor:canary` deploys a zero-traffic revision, steps traffic up with canary analysis, then promotes or goes around. Deployments show under **Operate > Environments > production**.

## 7. Fly your first intent

1. Create an issue from the **Intent** template, for example: *"Show how long each flight has been in the air on its strip in the console."* The template applies the `intent` label.
2. Watch the issue. The Dispatcher posts a flight plan with a predicted clearance, the Pilot opens a merge request, and the Inspector reviews it.
3. Watch the merge request. The pipeline generates its verification tier, the gate posts its decision, and, if the pilot has earned it, the merge request merges itself.
4. Watch `main`. You'll see the release, the canary steps and the landing, and the trust ledger moves.

[The product walkthrough](demo/script.md) presents the interface. Add actual session and pipeline footage only when demonstrating a verified live integration.

## 8. Integration evidence and maintenance

Retain actual issue, Duo session, MR, pipeline, release, rollback incident and deployment links when validating a live integration. The exported local mock rehearsal checks implementation behavior; label it separately from real pipeline history and agent execution.

Follow [CONTRIBUTING.md](../CONTRIBUTING.md) for protected-file bindings and owner review. The [architecture guide](architecture.md) describes the integration and state model.
