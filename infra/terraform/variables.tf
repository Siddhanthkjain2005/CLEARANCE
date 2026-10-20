variable "project_id" {
  description = "Google Cloud project ID."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run and Artifact Registry. Defaults to Montréal: 97% carbon-free energy, 11 gCO2e/kWh (Google, 2025)."
  type        = string
  default     = "northamerica-northeast1"
}

variable "service" {
  description = "Cloud Run service name."
  type        = string
  default     = "clearance-tower"
}

variable "gitlab_project" {
  description = "Full path of the GitLab project, e.g. my-group/clearance. The Tower syncs from it."
  type        = string
}

variable "gitlab_url" {
  description = "GitLab instance URL."
  type        = string
  default     = "https://gitlab.com"
}

variable "min_instances" {
  description = "Keep one instance warm so the console's event stream stays continuous. Set 0 to scale to zero."
  type        = number
  default     = 1
}

# Secret values. Pass them as masked CI/CD variables (TF_VAR_...) or on the
# command line; Terraform stores them only in Secret Manager and its state.
variable "gitlab_read_token" {
  description = "GitLab token with read_api scope for the Tower's live sync."
  type        = string
  sensitive   = true
}

variable "webhook_secret" {
  description = "Secret token configured on the GitLab project webhook."
  type        = string
  sensitive   = true
}

variable "tower_token" {
  description = "Bearer token CI jobs use to post flight events to the Tower (CLEARANCE_TOWER_TOKEN)."
  type        = string
  sensitive   = true
}
