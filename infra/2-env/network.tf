# Shared VPC host in the net project; app, data and ai attach as service
# projects. No public IPs: ingress arrives through the global load balancer
# (stage 3), Google APIs are reached through a Private Service Connect
# endpoint on the VPC-SC bundle, and outbound internet uses Cloud NAT with
# reserved addresses partners can allowlist (Guidewire Cloud, ISO, CMS).

locals {
  net_project = module.project["net"].project_id

  subnet_cidrs = {
    primary   = cidrsubnet(var.env_cidr, 4, 0) # x.x.0.0/20
    secondary = cidrsubnet(var.env_cidr, 4, 1) # x.x.16.0/20
  }
  psa_cidr = cidrsubnet(var.env_cidr, 4, 2)                 # x.x.32.0/20 for Cloud SQL, Memorystore
  psc_ip   = cidrhost(cidrsubnet(var.env_cidr, 8, 255), 10) # x.x.255.10

  private_api_zones = {
    googleapis = "googleapis.com."
    run        = "run.app."
    pkg        = "pkg.dev."
    gcr        = "gcr.io."
  }
}

resource "google_compute_network" "vpc" {
  project                         = local.net_project
  name                            = "fnol-${var.env}"
  auto_create_subnetworks         = false
  routing_mode                    = "GLOBAL"
  delete_default_routes_on_create = false
}

resource "google_compute_subnetwork" "subnet" {
  for_each                 = local.subnet_cidrs
  project                  = local.net_project
  name                     = "fnol-${var.env}-${var.regions[each.key]}"
  region                   = var.regions[each.key]
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = each.value
  private_ip_google_access = true

  log_config {
    aggregation_interval = "INTERVAL_5_SEC"
    flow_sampling        = var.env == "prd" ? 0.5 : 0.1
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

resource "google_compute_shared_vpc_host_project" "host" {
  project = local.net_project
}

resource "google_compute_shared_vpc_service_project" "service" {
  for_each        = toset(["app", "data", "ai"])
  host_project    = google_compute_shared_vpc_host_project.host.project
  service_project = module.project[each.key].project_id
}

# --------------------------------------------- private services access (PSA)

resource "google_compute_global_address" "psa" {
  project       = local.net_project
  name          = "psa-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  address       = split("/", local.psa_cidr)[0]
  prefix_length = tonumber(split("/", local.psa_cidr)[1])
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "psa" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa.name]
}

# -------------------------------- Private Service Connect for Google APIs

resource "google_compute_global_address" "psc_apis" {
  project      = local.net_project
  name         = "psc-google-apis"
  purpose      = "PRIVATE_SERVICE_CONNECT"
  address_type = "INTERNAL"
  address      = local.psc_ip
  network      = google_compute_network.vpc.id
}

resource "google_compute_global_forwarding_rule" "psc_apis" {
  project               = local.net_project
  name                  = "pscapis${var.env}"
  target                = "vpc-sc"
  network               = google_compute_network.vpc.id
  ip_address            = google_compute_global_address.psc_apis.id
  load_balancing_scheme = ""
}

resource "google_dns_managed_zone" "private_api" {
  for_each   = local.private_api_zones
  project    = local.net_project
  name       = "private-${each.key}"
  dns_name   = each.value
  visibility = "private"

  private_visibility_config {
    networks {
      network_url = google_compute_network.vpc.id
    }
  }
}

resource "google_dns_record_set" "private_api_wildcard" {
  for_each     = local.private_api_zones
  project      = local.net_project
  managed_zone = google_dns_managed_zone.private_api[each.key].name
  name         = "*.${each.value}"
  type         = "A"
  ttl          = 300
  rrdatas      = [local.psc_ip]
}

resource "google_dns_record_set" "private_api_apex" {
  for_each     = local.private_api_zones
  project      = local.net_project
  managed_zone = google_dns_managed_zone.private_api[each.key].name
  name         = each.value
  type         = "A"
  ttl          = 300
  rrdatas      = [local.psc_ip]
}

# ------------------------------------------------------------- egress / NAT

resource "google_compute_router" "nat" {
  for_each = tomap(var.regions)
  project  = local.net_project
  name     = "nat-${each.value}"
  region   = each.value
  network  = google_compute_network.vpc.id
}

resource "google_compute_address" "nat" {
  for_each = { for pair in setproduct(keys(var.regions), range(var.nat_ips_per_region)) : "${pair[0]}-${pair[1]}" => pair }
  project  = local.net_project
  name     = "nat-${var.regions[each.value[0]]}-${each.value[1]}"
  region   = var.regions[each.value[0]]
}

resource "google_compute_router_nat" "nat" {
  for_each                            = tomap(var.regions)
  project                             = local.net_project
  name                                = "nat-${each.value}"
  router                              = google_compute_router.nat[each.key].name
  region                              = each.value
  nat_ip_allocate_option              = "MANUAL_ONLY"
  nat_ips                             = [for k, a in google_compute_address.nat : a.self_link if startswith(k, "${each.key}-")]
  source_subnetwork_ip_ranges_to_nat  = "LIST_OF_SUBNETWORKS"
  enable_endpoint_independent_mapping = false

  subnetwork {
    name                    = google_compute_subnetwork.subnet[each.key].id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# ------------------------------------------------------------ firewall policy

resource "google_compute_network_firewall_policy" "fnol" {
  project = local.net_project
  name    = "fnol-${var.env}"
}

resource "google_compute_network_firewall_policy_association" "fnol" {
  project           = local.net_project
  name              = "fnol-${var.env}"
  firewall_policy   = google_compute_network_firewall_policy.fnol.name
  attachment_target = google_compute_network.vpc.id
}

resource "google_compute_network_firewall_policy_rule" "allow_health_checks" {
  project         = local.net_project
  firewall_policy = google_compute_network_firewall_policy.fnol.name
  priority        = 1000
  direction       = "INGRESS"
  action          = "allow"
  description     = "Google load balancer health checks"
  match {
    src_ip_ranges = ["35.191.0.0/16", "130.211.0.0/22"]
    layer4_configs {
      ip_protocol = "tcp"
    }
  }
}

resource "google_compute_network_firewall_policy_rule" "allow_internal" {
  project         = local.net_project
  firewall_policy = google_compute_network_firewall_policy.fnol.name
  priority        = 1100
  direction       = "INGRESS"
  action          = "allow"
  description     = "East-west traffic inside this environment and from on-prem"
  match {
    src_ip_ranges = concat([var.env_cidr], var.onprem_cidrs)
    layer4_configs {
      ip_protocol = "tcp"
    }
  }
}

resource "google_compute_network_firewall_policy_rule" "deny_ingress" {
  project         = local.net_project
  firewall_policy = google_compute_network_firewall_policy.fnol.name
  priority        = 65000
  direction       = "INGRESS"
  action          = "deny"
  enable_logging  = true
  match {
    src_ip_ranges = ["0.0.0.0/0"]
    layer4_configs {
      ip_protocol = "all"
    }
  }
}

resource "google_compute_network_firewall_policy_rule" "allow_egress_private" {
  project         = local.net_project
  firewall_policy = google_compute_network_firewall_policy.fnol.name
  priority        = 1000
  direction       = "EGRESS"
  action          = "allow"
  description     = "Google APIs over PSC, this environment, on-prem"
  match {
    dest_ip_ranges = concat(["${local.psc_ip}/32", var.env_cidr], var.onprem_cidrs)
    layer4_configs {
      ip_protocol = "all"
    }
  }
}

# Phase 4 replaces this with Secure Web Proxy and an FQDN allowlist.
resource "google_compute_network_firewall_policy_rule" "allow_egress_https" {
  project         = local.net_project
  firewall_policy = google_compute_network_firewall_policy.fnol.name
  priority        = 2000
  direction       = "EGRESS"
  action          = "allow"
  description     = "HTTPS to partners through Cloud NAT"
  enable_logging  = true
  match {
    dest_ip_ranges = ["0.0.0.0/0"]
    layer4_configs {
      ip_protocol = "tcp"
      ports       = ["443"]
    }
  }
}

resource "google_compute_network_firewall_policy_rule" "deny_egress" {
  project         = local.net_project
  firewall_policy = google_compute_network_firewall_policy.fnol.name
  priority        = 65000
  direction       = "EGRESS"
  action          = "deny"
  enable_logging  = true
  match {
    dest_ip_ranges = ["0.0.0.0/0"]
    layer4_configs {
      ip_protocol = "all"
    }
  }
}
