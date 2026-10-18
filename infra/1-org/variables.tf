variable "org_id" {
  type = string
}

variable "directory_customer_id" {
  type        = string
  description = "Cloud Identity customer ID for jmarcellis.com, e.g. C01abc234 (gcloud organizations describe ORG_ID)."
}

variable "billing_account" {
  type = string
}

variable "fnol_folder" {
  type        = string
  description = "Output fnol_folder from 0-bootstrap, as folders/NUMBER."
}

variable "terraform_service_account" {
  type = string
}

variable "prefix" {
  type    = string
  default = "jmfnol"
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "audit_log_retention_days" {
  type        = number
  description = "Audit log retention. Claim files are kept longer in GCS; this covers platform audit trails."
  default     = 2557 # 7 years
}

variable "group_bindings" {
  type        = map(map(list(string)))
  description = "env => group email => roles granted on that environment folder."
  default = {
    dev = {
      "gcp-fnol-developers@jmarcellis.com" = ["roles/editor"]
    }
    stg = {
      "gcp-fnol-developers@jmarcellis.com" = ["roles/viewer"]
    }
    prd = {
      "gcp-fnol-sre@jmarcellis.com" = ["roles/viewer", "roles/monitoring.editor"]
    }
  }
}
