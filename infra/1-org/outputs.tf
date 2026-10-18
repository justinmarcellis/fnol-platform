output "env_folders" {
  value = { for k, f in google_folder.env : k => f.name }
}

output "common_folder" {
  value = google_folder.common.name
}

output "logging_project_id" {
  value = module.logging.project_id
}

output "cicd_project_id" {
  value = module.cicd.project_id
}

output "artifact_registry" {
  value = "${var.region}-docker.pkg.dev/${module.cicd.project_id}/${google_artifact_registry_repository.containers.repository_id}"
}

output "access_policy_id" {
  value = google_access_context_manager_access_policy.fnol.name
}
