variable "org_id" {
  type        = string
  description = "Numeric organization ID of jmarcellis.com (gcloud organizations list)."
}

variable "billing_account" {
  type        = string
  description = "Billing account ID, format XXXXXX-XXXXXX-XXXXXX."
}

variable "prefix" {
  type        = string
  description = "Short prefix for globally unique project and bucket names."
  default     = "jmfnol"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,12}$", var.prefix))
    error_message = "Use 3-13 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "platform_admins_group" {
  type        = string
  description = "Google group allowed to impersonate the Terraform service account."
  default     = "gcp-fnol-admins@jmarcellis.com"
}
