# Optional HA VPN to the in-house claims and policy systems. Created only
# when var.onprem_vpn is set. Guidewire Cloud is reached over HTTPS through
# Cloud NAT instead, so it does not need this.

locals {
  vpn_enabled = var.onprem_vpn != null
  vpn_tunnels = local.vpn_enabled ? { "0" = 0, "1" = 1 } : {}
}

resource "google_compute_ha_vpn_gateway" "onprem" {
  count   = local.vpn_enabled ? 1 : 0
  project = local.net_project
  name    = "onprem-${var.env}"
  region  = var.regions.primary
  network = google_compute_network.vpc.id
}

resource "google_compute_external_vpn_gateway" "onprem" {
  count           = local.vpn_enabled ? 1 : 0
  project         = local.net_project
  name            = "onprem-peer-${var.env}"
  redundancy_type = length(var.onprem_vpn.peer_ips) > 1 ? "TWO_IPS_REDUNDANCY" : "SINGLE_IP_INTERNALLY_REDUNDANT"

  dynamic "interface" {
    for_each = var.onprem_vpn.peer_ips
    content {
      id         = interface.key
      ip_address = interface.value
    }
  }
}

resource "google_compute_router" "vpn" {
  count   = local.vpn_enabled ? 1 : 0
  project = local.net_project
  name    = "vpn-${var.env}"
  region  = var.regions.primary
  network = google_compute_network.vpc.id

  bgp {
    asn               = var.onprem_vpn.gcp_asn
    advertise_mode    = "CUSTOM"
    advertised_groups = ["ALL_SUBNETS"]
    advertised_ip_ranges {
      range = "${local.psc_ip}/32"
    }
  }
}

resource "random_password" "vpn_psk" {
  for_each = local.vpn_tunnels
  length   = 32
  special  = false
}

resource "google_secret_manager_secret" "vpn_psk" {
  for_each  = local.vpn_tunnels
  project   = module.project["sec"].project_id
  secret_id = "vpn-psk-${var.env}-${each.key}"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "vpn_psk" {
  for_each    = local.vpn_tunnels
  secret      = google_secret_manager_secret.vpn_psk[each.key].id
  secret_data = random_password.vpn_psk[each.key].result
}

resource "google_compute_vpn_tunnel" "onprem" {
  for_each                        = local.vpn_tunnels
  project                         = local.net_project
  name                            = "onprem-${var.env}-${each.key}"
  region                          = var.regions.primary
  vpn_gateway                     = google_compute_ha_vpn_gateway.onprem[0].id
  vpn_gateway_interface           = each.value
  peer_external_gateway           = google_compute_external_vpn_gateway.onprem[0].id
  peer_external_gateway_interface = length(var.onprem_vpn.peer_ips) > 1 ? each.value : 0
  shared_secret                   = random_password.vpn_psk[each.key].result
  router                          = google_compute_router.vpn[0].id
  ike_version                     = 2
}

resource "google_compute_router_interface" "onprem" {
  for_each   = local.vpn_tunnels
  project    = local.net_project
  name       = "onprem-${each.key}"
  region     = var.regions.primary
  router     = google_compute_router.vpn[0].name
  ip_range   = "169.254.${10 + each.value}.1/30"
  vpn_tunnel = google_compute_vpn_tunnel.onprem[each.key].name
}

resource "google_compute_router_peer" "onprem" {
  for_each        = local.vpn_tunnels
  project         = local.net_project
  name            = "onprem-${each.key}"
  region          = var.regions.primary
  router          = google_compute_router.vpn[0].name
  interface       = google_compute_router_interface.onprem[each.key].name
  peer_ip_address = "169.254.${10 + each.value}.2"
  peer_asn        = var.onprem_vpn.peer_asn
}
