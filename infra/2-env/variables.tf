variable "env" {
  type = string
  validation {
    condition     = contains(["dev", "stg", "prd"], var.env)
    error_message = "env must be dev, stg or prd."
  }
}

variable "prefix" {
  type    = string
  default = "jmfnol"
}

variable "billing_account" {
  type = string
}

variable "state_bucket" {
  type        = string
  description = "tfstate_bucket output from 0-bootstrap."
}

variable "terraform_service_account" {
  type = string
}

variable "regions" {
  type = object({
    primary   = string
    secondary = string
  })
  default = {
    primary   = "us-central1"
    secondary = "us-east4"
  }
}

variable "env_cidr" {
  type        = string
  description = "One /16 per environment; must not overlap on-prem ranges."
}

variable "nat_ips_per_region" {
  type    = number
  default = 2
}

variable "onprem_cidrs" {
  type        = list(string)
  description = "On-prem ranges for the in-house claims and policy systems."
  default     = []
}

variable "onprem_vpn" {
  description = "Set to create HA VPN to on-prem. Leave null to skip."
  type = object({
    peer_ips = list(string)
    peer_asn = number
    gcp_asn  = number
  })
  default = null
}

variable "perimeter_enforced" {
  type        = bool
  description = "false = VPC-SC dry-run (log only); true = enforce."
  default     = false
}

variable "perimeter_admin_identities" {
  type        = list(string)
  description = "Extra user: or serviceAccount: identities allowed into the perimeter from outside, such as CI deployers."
  default     = []
}
