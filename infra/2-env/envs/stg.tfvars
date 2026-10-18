env                       = "stg"
billing_account           = "000000-000000-000000"
state_bucket              = "jmfnol-tfstate"
terraform_service_account = "terraform-fnol@jmfnol-seed.iam.gserviceaccount.com"
env_cidr                  = "10.20.0.0/16"
perimeter_enforced        = false

# In-house claims / policy systems. Uncomment when the on-prem side is ready.
# onprem_cidrs = ["192.168.0.0/16"]
# onprem_vpn = {
#   peer_ips = ["203.0.113.10"]
#   peer_asn = 65001
#   gcp_asn  = 64520
# }
