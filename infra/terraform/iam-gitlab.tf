# Permissions for GitLab CI through the Google Cloud IAM integration
# (workload identity federation). Create the pool and provider with GitLab's
# guided setup (Settings > Integrations > Google Cloud IAM), then pass their
# IDs here so pipeline jobs with `identity: google_cloud` can deploy.

variable "wif_pool_project_number" {
  description = "Project number that hosts the workload identity pool. Leave empty to skip CI bindings."
  type        = string
  default     = ""
}

variable "wif_pool_id" {
  description = "Workload identity pool ID created by GitLab's guided setup."
  type        = string
  default     = ""
}

variable "gitlab_project_id" {
  description = "Numeric GitLab project ID, used to scope the principal set."
  type        = string
  default     = ""
}

locals {
  ci_principal = var.wif_pool_id == "" ? null : "principalSet://iam.googleapis.com/projects/${var.wif_pool_project_number}/locations/global/workloadIdentityPools/${var.wif_pool_id}/attribute.project_id/${var.gitlab_project_id}"
  ci_roles     = ["roles/run.developer", "roles/artifactregistry.writer"]
}

resource "google_project_iam_member" "ci" {
  for_each = local.ci_principal == null ? toset([]) : toset(local.ci_roles)
  project  = var.project_id
  role     = each.value
  member   = local.ci_principal
}

# Deploying a revision that runs as the Tower's service account requires actAs.
resource "google_service_account_iam_member" "ci_act_as" {
  count              = local.ci_principal == null ? 0 : 1
  service_account_id = google_service_account.tower.name
  role               = "roles/iam.serviceAccountUser"
  member             = local.ci_principal
}
