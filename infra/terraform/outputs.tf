output "tower_url" {
  description = "Public URL of the Clearance Tower. Set it as CLEARANCE_TOWER_URL in GitLab CI/CD variables."
  value       = google_cloud_run_v2_service.tower.uri
}

output "artifact_registry" {
  description = "Image repository the pipeline copies releases into."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.clearance.repository_id}"
}

output "runtime_service_account" {
  value = google_service_account.tower.email
}
