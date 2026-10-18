# One runtime service account per service, all in the app project.
# Stage 2 creates them and lets them use the Shared VPC subnets; each
# service's own data and API roles are granted alongside the service in
# phase 1, so no account holds a role before it needs it.

locals {
  app_project = module.project["app"].project_id

  runtime_accounts = {
    "intake-api"  = "Draft lifecycle and submit"
    "copilot"     = "Model cascade orchestrator"
    "compliance"  = "Rules evaluation"
    "rules-admin" = "Rules authoring and approval"
    "media"       = "Upload scan, DLP and extraction"
    "saga"        = "Submission workflow"
    "adapters"    = "Guidewire, in-house and partner adapters"
    "notify"      = "Customer email and SMS"
    "web-agent"   = "Agent console static server"
    "gateway"     = "API Gateway backend invoker"
  }
}

resource "google_service_account" "runtime" {
  for_each     = local.runtime_accounts
  project      = local.app_project
  account_id   = "fnol-${each.key}"
  display_name = each.value
}

resource "google_project_service_identity" "run" {
  provider = google-beta
  project  = local.app_project
  service  = "run.googleapis.com"
}

# Cloud Run (and Cloud Functions gen2) Direct VPC egress needs network user
# on the subnet for the serverless service agent and the runtime accounts.
locals {
  subnet_users = merge(
    { for k, sa in google_service_account.runtime : k => "serviceAccount:${sa.email}" },
    { "run-agent" = "serviceAccount:${google_project_service_identity.run.email}" },
  )
  subnet_bindings = {
    for pair in setproduct(keys(local.subnet_cidrs), keys(local.subnet_users)) :
    "${pair[0]}/${pair[1]}" => { subnet = pair[0], member = local.subnet_users[pair[1]] }
  }
}

resource "google_compute_subnetwork_iam_member" "network_user" {
  for_each   = local.subnet_bindings
  project    = local.net_project
  region     = google_compute_subnetwork.subnet[each.value.subnet].region
  subnetwork = google_compute_subnetwork.subnet[each.value.subnet].name
  role       = "roles/compute.networkUser"
  member     = each.value.member
}

# Cloud Run pulls images from the shared Artifact Registry in the cicd project.
resource "google_artifact_registry_repository_iam_member" "run_pull" {
  project    = local.org.cicd_project_id
  location   = var.regions.primary
  repository = "fnol"
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_project_service_identity.run.email}"
}
