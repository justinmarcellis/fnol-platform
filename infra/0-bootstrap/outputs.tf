output "fnol_folder" {
  value = google_folder.fnol.name
}

output "seed_project_id" {
  value = module.seed.project_id
}

output "tfstate_bucket" {
  value = google_storage_bucket.tfstate.name
}

output "terraform_service_account" {
  value = google_service_account.terraform.email
}
