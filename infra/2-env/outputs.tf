output "projects" {
  value = { for k, p in module.project : k => p.project_id }
}

output "network" {
  value = google_compute_network.vpc.id
}

output "subnets" {
  value = { for k, s in google_compute_subnetwork.subnet : k => s.id }
}

output "nat_egress_ips" {
  description = "Give these to Guidewire Cloud, ISO and other partners for allowlisting."
  value       = [for a in google_compute_address.nat : a.address]
}

output "runtime_service_accounts" {
  value = { for k, sa in google_service_account.runtime : k => sa.email }
}

output "kms_keys" {
  value = merge(
    { for k, key in google_kms_crypto_key.key : k => key.id },
    { "us/pii-tokenization" = google_kms_crypto_key.pii_tokenization.id },
  )
}

output "psc_google_apis_ip" {
  value = local.psc_ip
}
