# VPC Service Controls perimeter around all five environment projects.
# Starts in dry-run: violations are logged but not blocked. Review the
# "VPC Service Controls" audit logs, then set perimeter_enforced = true.

locals {
  perimeter_projects = [for k, p in module.project : "projects/${p.number}"]

  restricted_services = [
    "aiplatform.googleapis.com",
    "bigquery.googleapis.com",
    "bigquerystorage.googleapis.com",
    "cloudkms.googleapis.com",
    "datastream.googleapis.com",
    "dlp.googleapis.com",
    "documentai.googleapis.com",
    "firestore.googleapis.com",
    "pubsub.googleapis.com",
    "secretmanager.googleapis.com",
    "speech.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
  ]

  # Non-data APIs the services call from inside the VPC.
  vpc_accessible_services = concat(["RESTRICTED-SERVICES"], [
    "artifactregistry.googleapis.com",
    "cloudtasks.googleapis.com",
    "cloudtrace.googleapis.com",
    "contactcenterinsights.googleapis.com",
    "dialogflow.googleapis.com",
    "discoveryengine.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "modelarmor.googleapis.com",
    "monitoring.googleapis.com",
    "run.googleapis.com",
    "sts.googleapis.com",
    "translate.googleapis.com",
    "workflowexecutions.googleapis.com",
    "workflows.googleapis.com",
  ])

  perimeter_admins = concat(
    ["serviceAccount:${var.terraform_service_account}"],
    var.perimeter_admin_identities,
  )
}

resource "google_access_context_manager_service_perimeter" "env" {
  parent                    = "accessPolicies/${local.org.access_policy_id}"
  name                      = "accessPolicies/${local.org.access_policy_id}/servicePerimeters/fnol_${var.env}"
  title                     = "fnol_${var.env}"
  perimeter_type            = "PERIMETER_TYPE_REGULAR"
  use_explicit_dry_run_spec = !var.perimeter_enforced

  dynamic "status" {
    for_each = var.perimeter_enforced ? [1] : []
    content {
      resources           = local.perimeter_projects
      restricted_services = local.restricted_services
      vpc_accessible_services {
        enable_restriction = true
        allowed_services   = local.vpc_accessible_services
      }
      ingress_policies {
        ingress_from {
          identities = local.perimeter_admins
          sources {
            access_level = "*"
          }
        }
        ingress_to {
          resources = ["*"]
          operations {
            service_name = "*"
          }
        }
      }
    }
  }

  dynamic "spec" {
    for_each = var.perimeter_enforced ? [] : [1]
    content {
      resources           = local.perimeter_projects
      restricted_services = local.restricted_services
      vpc_accessible_services {
        enable_restriction = true
        allowed_services   = local.vpc_accessible_services
      }
      ingress_policies {
        ingress_from {
          identities = local.perimeter_admins
          sources {
            access_level = "*"
          }
        }
        ingress_to {
          resources = ["*"]
          operations {
            service_name = "*"
          }
        }
      }
    }
  }
}
