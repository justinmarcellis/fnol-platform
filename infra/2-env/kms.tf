# Customer-managed encryption keys (HSM) in the environment's security
# project. Keys must live in the same location as the data they protect:
# "us" multi-region for Firestore (nam5), GCS (US), BigQuery (US) and
# Pub/Sub; regional keys for Cloud SQL and Vertex AI.

locals {
  sec_project = module.project["sec"].project_id

  keyrings = {
    us        = "us"
    primary   = var.regions.primary
    secondary = var.regions.secondary
  }

  keys = {
    "us/firestore"  = "us"
    "us/storage"    = "us"
    "us/bigquery"   = "us"
    "us/pubsub"     = "us"
    "primary/sql"   = "primary"
    "primary/ai"    = "primary"
    "secondary/sql" = "secondary"
  }
}

resource "google_kms_key_ring" "env" {
  for_each = local.keyrings
  project  = local.sec_project
  name     = "fnol-${var.env}-${each.value}"
  location = each.value
}

resource "google_kms_crypto_key" "key" {
  for_each        = local.keys
  name            = split("/", each.key)[1]
  key_ring        = google_kms_key_ring.env[each.value].id
  rotation_period = "7776000s" # 90 days
  purpose         = "ENCRYPT_DECRYPT"

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "HSM"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Service agents that encrypt with the keys.
resource "google_project_service_identity" "agent" {
  provider = google-beta
  for_each = {
    firestore = { project = "data", service = "firestore.googleapis.com" }
    sql       = { project = "data", service = "sqladmin.googleapis.com" }
    pubsub    = { project = "app", service = "pubsub.googleapis.com" }
    ai        = { project = "ai", service = "aiplatform.googleapis.com" }
  }
  project = module.project[each.value.project].project_id
  service = each.value.service
}

data "google_storage_project_service_account" "data" {
  project = module.project["data"].project_id
}

data "google_bigquery_default_service_account" "data" {
  project = module.project["data"].project_id
}

locals {
  key_users = {
    "us/firestore"  = "serviceAccount:${google_project_service_identity.agent["firestore"].email}"
    "us/storage"    = "serviceAccount:${data.google_storage_project_service_account.data.email_address}"
    "us/bigquery"   = "serviceAccount:${data.google_bigquery_default_service_account.data.email}"
    "us/pubsub"     = "serviceAccount:${google_project_service_identity.agent["pubsub"].email}"
    "primary/sql"   = "serviceAccount:${google_project_service_identity.agent["sql"].email}"
    "secondary/sql" = "serviceAccount:${google_project_service_identity.agent["sql"].email}"
    "primary/ai"    = "serviceAccount:${google_project_service_identity.agent["ai"].email}"
  }
}

resource "google_kms_crypto_key_iam_member" "agent" {
  for_each      = local.key_users
  crypto_key_id = google_kms_crypto_key.key[each.key].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = each.value
}

# Key that wraps the Sensitive Data Protection tokenization key for SSN,
# MBI and driver's licence numbers captured at FNOL.
resource "google_kms_crypto_key" "pii_tokenization" {
  name            = "pii-tokenization"
  key_ring        = google_kms_key_ring.env["us"].id
  rotation_period = "7776000s"

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "HSM"
  }

  lifecycle {
    prevent_destroy = true
  }
}
