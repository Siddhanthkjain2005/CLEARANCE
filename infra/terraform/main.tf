# Clearance on Google Cloud: an Artifact Registry repository, a least-privilege
# runtime identity, the secrets the Tower reads, and the Cloud Run service.
#
# The pipeline owns revisions and traffic (progressive delivery in
# `clearance fly`), so Terraform ignores the image and traffic split and only
# manages the service's shape: scaling, resources, environment and access.

locals {
  secrets = {
    gitlab_token   = "clearance-gitlab-token"   # read_api token for live sync
    webhook_secret = "clearance-webhook-secret" # X-Gitlab-Token for webhooks
    tower_token    = "clearance-tower-token"    # bearer token CI uses to post events
  }
}

resource "google_project_service" "apis" {
  for_each           = toset(["run.googleapis.com", "artifactregistry.googleapis.com", "secretmanager.googleapis.com", "iamcredentials.googleapis.com"])
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "clearance" {
  location      = var.region
  repository_id = "clearance"
  format        = "DOCKER"
  description   = "Clearance Tower images, copied from the GitLab container registry by the pipeline."

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 20
    }
  }
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "2592000s" # 30 days: old images are storage we don't need
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_service_account" "tower" {
  account_id   = "clearance-tower"
  display_name = "Clearance Tower runtime"
}

resource "google_secret_manager_secret" "secret" {
  for_each  = local.secrets
  secret_id = each.value
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "gitlab_token" {
  secret      = google_secret_manager_secret.secret["gitlab_token"].id
  secret_data = var.gitlab_read_token
}

resource "google_secret_manager_secret_version" "webhook_secret" {
  secret      = google_secret_manager_secret.secret["webhook_secret"].id
  secret_data = var.webhook_secret
}

resource "google_secret_manager_secret_version" "tower_token" {
  secret      = google_secret_manager_secret.secret["tower_token"].id
  secret_data = var.tower_token
}

resource "google_secret_manager_secret_iam_member" "tower_reads" {
  for_each  = google_secret_manager_secret.secret
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.tower.email}"
}

resource "google_cloud_run_v2_service" "tower" {
  name                = var.service
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account                  = google_service_account.tower.email
    max_instance_request_concurrency = 80
    timeout                          = "3600s" # long-lived event streams

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = 3
    }

    containers {
      image = "us-docker.pkg.dev/cloudrun/container/hello" # replaced by the pipeline's first deployment
      ports {
        container_port = 8080
      }
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true # CPU only while serving: less energy at idle
        startup_cpu_boost = true
      }
      env {
        name  = "CLEARANCE_PROJECT"
        value = var.gitlab_project
      }
      env {
        name  = "CLEARANCE_GITLAB_URL"
        value = var.gitlab_url
      }
      env {
        name  = "CLEARANCE_REGION"
        value = var.region
      }
      dynamic "env" {
        for_each = {
          CLEARANCE_GITLAB_TOKEN   = local.secrets.gitlab_token
          CLEARANCE_WEBHOOK_SECRET = local.secrets.webhook_secret
          CLEARANCE_TOWER_TOKEN    = local.secrets.tower_token
        }
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      startup_probe {
        http_get {
          path = "/api/health"
        }
        initial_delay_seconds = 1
        period_seconds        = 2
        failure_threshold     = 10
      }
      liveness_probe {
        http_get {
          path = "/api/health"
        }
        period_seconds = 30
      }
    }
  }

  lifecycle {
    # Revisions and traffic belong to the pipeline's progressive delivery.
    ignore_changes = [
      template[0].containers[0].image,
      template[0].revision,
      template[0].labels,
      template[0].annotations,
      traffic,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_project_service.apis,
    google_secret_manager_secret_iam_member.tower_reads,
    google_secret_manager_secret_version.gitlab_token,
    google_secret_manager_secret_version.webhook_secret,
    google_secret_manager_secret_version.tower_token,
  ]
}

# The console and API are public; writes are authenticated by tokens in the app.
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.tower.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
