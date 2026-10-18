# Stage 2: one environment (dev, stg or prd). Apply once per environment:
#   terraform init -backend-config=../backend.auto.hcl -backend-config="prefix=2-env/dev"
#   terraform apply -var-file=envs/dev.tfvars

terraform {
  required_version = ">= 1.6"
  backend "gcs" {}
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.10"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.10"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "google" {
  region                      = var.regions.primary
  impersonate_service_account = var.terraform_service_account
}

provider "google-beta" {
  region                      = var.regions.primary
  impersonate_service_account = var.terraform_service_account
}

data "terraform_remote_state" "org" {
  backend = "gcs"
  config = {
    bucket = var.state_bucket
    prefix = "1-org"
  }
}

locals {
  org        = data.terraform_remote_state.org.outputs
  env_folder = local.org.env_folders[var.env]
  labels     = { system = "fnol", env = var.env }

  projects = {
    net = {
      name = "FNOL network ${var.env}"
      services = [
        "compute.googleapis.com",
        "dns.googleapis.com",
        "servicenetworking.googleapis.com",
        "networkmanagement.googleapis.com",
        "networksecurity.googleapis.com",
      ]
    }
    app = {
      name = "FNOL application ${var.env}"
      services = [
        "apigateway.googleapis.com",
        "artifactregistry.googleapis.com",
        "cloudbuild.googleapis.com",
        "cloudfunctions.googleapis.com",
        "cloudscheduler.googleapis.com",
        "cloudtasks.googleapis.com",
        "compute.googleapis.com",
        "eventarc.googleapis.com",
        "firebase.googleapis.com",
        "firebaseappcheck.googleapis.com",
        "firebasehosting.googleapis.com",
        "iap.googleapis.com",
        "identitytoolkit.googleapis.com",
        "pubsub.googleapis.com",
        "recaptchaenterprise.googleapis.com",
        "run.googleapis.com",
        "servicecontrol.googleapis.com",
        "servicemanagement.googleapis.com",
        "workflows.googleapis.com",
        "workflowexecutions.googleapis.com",
        "cloudtrace.googleapis.com",
        "monitoring.googleapis.com",
      ]
    }
    data = {
      name = "FNOL data ${var.env}"
      services = [
        "bigquery.googleapis.com",
        "bigquerystorage.googleapis.com",
        "dataplex.googleapis.com",
        "datastream.googleapis.com",
        "firestore.googleapis.com",
        "redis.googleapis.com",
        "sqladmin.googleapis.com",
        "storage.googleapis.com",
      ]
    }
    ai = {
      name = "FNOL AI ${var.env}"
      services = [
        "aiplatform.googleapis.com",
        "contactcenterinsights.googleapis.com",
        "dialogflow.googleapis.com",
        "discoveryengine.googleapis.com",
        "documentai.googleapis.com",
        "modelarmor.googleapis.com",
        "speech.googleapis.com",
        "translate.googleapis.com",
      ]
    }
    sec = {
      name = "FNOL security ${var.env}"
      services = [
        "cloudkms.googleapis.com",
        "dlp.googleapis.com",
        "secretmanager.googleapis.com",
      ]
    }
  }
}

module "project" {
  source          = "../modules/project"
  for_each        = local.projects
  project_id      = "${var.prefix}-${each.key}-${var.env}"
  name            = each.value.name
  folder_id       = local.env_folder
  billing_account = var.billing_account
  labels          = merge(local.labels, { tier = each.key })
  services        = each.value.services
}

# Firebase is layered onto the application project: Hosting for the
# policyholder app, Identity Platform for auth, App Check for abuse control.
resource "google_firebase_project" "app" {
  provider = google-beta
  project  = module.project["app"].project_id
}
