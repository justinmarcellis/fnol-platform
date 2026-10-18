# Stage 1: folders, guardrail org policies, shared projects, audit log sink
# and the VPC Service Controls access policy scoped to the fnol folder.
# Everything here is attached to the fnol folder, so nothing changes for the
# rest of the jmarcellis.com organization.

terraform {
  required_version = ">= 1.6"
  backend "gcs" {
    prefix = "1-org"
  }
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.10"
    }
  }
}

provider "google" {
  region                      = var.region
  impersonate_service_account = var.terraform_service_account
}

locals {
  envs = ["dev", "stg", "prd"]
}

resource "google_folder" "common" {
  display_name = "common"
  parent       = var.fnol_folder
}

resource "google_folder" "env" {
  for_each     = toset(local.envs)
  display_name = each.value
  parent       = var.fnol_folder
}

# ---------------------------------------------------------------- org policy

locals {
  boolean_policies = [
    "iam.disableServiceAccountKeyCreation",
    "iam.disableServiceAccountKeyUpload",
    "iam.automaticIamGrantsForDefaultServiceAccounts",
    "storage.uniformBucketLevelAccess",
    "compute.skipDefaultNetworkCreation",
    "compute.requireOsLogin",
    "sql.restrictPublicIp",
    "compute.disableSerialPortAccess",
  ]
}

resource "google_org_policy_policy" "boolean" {
  for_each = toset(local.boolean_policies)
  name     = "${var.fnol_folder}/policies/${each.value}"
  parent   = var.fnol_folder
  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "public_access_prevention" {
  name   = "${var.fnol_folder}/policies/storage.publicAccessPrevention"
  parent = var.fnol_folder
  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "no_vm_external_ip" {
  name   = "${var.fnol_folder}/policies/compute.vmExternalIpAccess"
  parent = var.fnol_folder
  spec {
    rules {
      deny_all = "TRUE"
    }
  }
}

# Keep all data in the United States.
resource "google_org_policy_policy" "locations" {
  name   = "${var.fnol_folder}/policies/gcp.resourceLocations"
  parent = var.fnol_folder
  spec {
    rules {
      values {
        allowed_values = ["in:us-locations"]
      }
    }
  }
}

# Only identities from the jmarcellis.com Workspace / Cloud Identity tenant
# can be granted IAM roles. Public web traffic reaches Cloud Run through the
# load balancer, API Gateway and IAP, which invoke with their own service
# accounts, so allUsers is never needed.
resource "google_org_policy_policy" "domain_restricted_sharing" {
  name   = "${var.fnol_folder}/policies/iam.allowedPolicyMemberDomains"
  parent = var.fnol_folder
  spec {
    rules {
      values {
        allowed_values = [var.directory_customer_id]
      }
    }
  }
}

resource "google_org_policy_policy" "run_ingress" {
  name   = "${var.fnol_folder}/policies/run.allowedIngress"
  parent = var.fnol_folder
  spec {
    rules {
      values {
        allowed_values = ["is:internal", "is:internal-and-cloud-load-balancing"]
      }
    }
  }
}

# ---------------------------------------------------------- shared projects

module "logging" {
  source          = "../modules/project"
  project_id      = "${var.prefix}-logging"
  name            = "FNOL logging"
  folder_id       = google_folder.common.name
  billing_account = var.billing_account
  labels          = { system = "fnol", env = "common" }
  services        = ["logging.googleapis.com", "bigquery.googleapis.com"]
}

module "cicd" {
  source          = "../modules/project"
  project_id      = "${var.prefix}-cicd"
  name            = "FNOL CI/CD"
  folder_id       = google_folder.common.name
  billing_account = var.billing_account
  labels          = { system = "fnol", env = "common" }
  services = [
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "clouddeploy.googleapis.com",
    "binaryauthorization.googleapis.com",
    "containeranalysis.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
  ]
}

resource "google_artifact_registry_repository" "containers" {
  project       = module.cicd.project_id
  location      = var.region
  repository_id = "fnol"
  format        = "DOCKER"
  description   = "Container images for FNOL services"

  docker_config {
    immutable_tags = true
  }
}

# ------------------------------------------------------------- audit logs

resource "google_logging_project_bucket_config" "audit" {
  project          = module.logging.project_id
  location         = "us"
  bucket_id        = "fnol-audit"
  retention_days   = var.audit_log_retention_days
  enable_analytics = true
}

resource "google_logging_folder_sink" "audit" {
  name             = "fnol-audit"
  folder           = var.fnol_folder
  include_children = true
  destination      = "logging.googleapis.com/${google_logging_project_bucket_config.audit.id}"
  filter           = "logName:\"cloudaudit.googleapis.com\" OR log_id(\"claims.fnol/audit\")"
}

resource "google_project_iam_member" "audit_sink_writer" {
  project = module.logging.project_id
  role    = "roles/logging.bucketWriter"
  member  = google_logging_folder_sink.audit.writer_identity
}

# Data Access audit logs on for the services that hold claim data.
resource "google_folder_iam_audit_config" "data_access" {
  for_each = toset([
    "firestore.googleapis.com",
    "storage.googleapis.com",
    "bigquery.googleapis.com",
    "cloudsql.googleapis.com",
    "aiplatform.googleapis.com",
    "cloudkms.googleapis.com",
    "secretmanager.googleapis.com",
  ])
  folder  = var.fnol_folder
  service = each.value
  audit_log_config {
    log_type = "ADMIN_READ"
  }
  audit_log_config {
    log_type = "DATA_READ"
  }
  audit_log_config {
    log_type = "DATA_WRITE"
  }
}

# ------------------------------------------------- VPC Service Controls

# A scoped access policy covers only the fnol folder, so it cannot collide
# with an existing organization-wide policy.
resource "google_access_context_manager_access_policy" "fnol" {
  parent = "organizations/${var.org_id}"
  title  = "fnol"
  scopes = [var.fnol_folder]
}

# --------------------------------------------------------------- folder IAM

resource "google_folder_iam_member" "groups" {
  for_each = {
    for b in flatten([
      for env, bindings in var.group_bindings : [
        for group, roles in bindings : [
          for role in roles : { key = "${env}/${group}/${role}", env = env, group = group, role = role }
        ]
      ]
    ]) : b.key => b
  }
  folder = google_folder.env[each.value.env].name
  role   = each.value.role
  member = "group:${each.value.group}"
}
