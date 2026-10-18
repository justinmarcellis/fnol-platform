# Creates one GCP project with billing, labels, enabled APIs and no default network.

terraform {
  required_providers {
    google = {
      source = "hashicorp/google"
    }
  }
}

variable "project_id" {
  type        = string
  description = "Globally unique project ID."
}

variable "name" {
  type        = string
  description = "Display name."
}

variable "folder_id" {
  type        = string
  description = "Parent folder, as folders/NUMBER or NUMBER."
}

variable "billing_account" {
  type = string
}

variable "labels" {
  type    = map(string)
  default = {}
}

variable "services" {
  type        = list(string)
  description = "APIs to enable."
  default     = []
}

locals {
  folder_number = trimprefix(var.folder_id, "folders/")
}

resource "google_project" "this" {
  project_id          = var.project_id
  name                = var.name
  folder_id           = local.folder_number
  billing_account     = var.billing_account
  labels              = var.labels
  auto_create_network = false
  deletion_policy     = "PREVENT"
}

resource "google_project_service" "this" {
  for_each                   = toset(var.services)
  project                    = google_project.this.project_id
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
}

output "project_id" {
  value      = google_project.this.project_id
  depends_on = [google_project_service.this]
}

output "number" {
  value = google_project.this.number
}
