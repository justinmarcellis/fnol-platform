# FNOL platform infrastructure (Phase 0 landing zone)

Terraform for the jmarcellis.com Google Cloud organization. Everything lives
under one `fnol` folder, so nothing outside it is changed.

```
jmarcellis.com (org)
└── fnol/                        0-bootstrap: folder, seed project, state bucket, Terraform SA
    ├── jmfnol-seed
    ├── common/                  1-org
    │   ├── jmfnol-logging       7-year audit log bucket (folder sink)
    │   └── jmfnol-cicd          Artifact Registry, Cloud Build, Cloud Deploy
    ├── dev/  stg/  prd/         2-env, once per environment
    │   ├── jmfnol-net-ENV       Shared VPC host, NAT, PSC for Google APIs, DNS, firewall, VPN
    │   ├── jmfnol-app-ENV       Cloud Run, Functions, Workflows, Pub/Sub, Firebase
    │   ├── jmfnol-data-ENV      Firestore, Cloud SQL, GCS, BigQuery
    │   ├── jmfnol-ai-ENV        Vertex AI (Gemini + Claude), CES / Agent Assist, Speech, Document AI
    │   └── jmfnol-sec-ENV       Cloud KMS (HSM), Secret Manager, Sensitive Data Protection
```

Guardrails set on the `fnol` folder: no service account keys, domain-restricted
sharing, US-only resource locations, no VM external IPs, no public Cloud SQL,
uniform bucket access and public access prevention, Cloud Run ingress limited
to internal and load balancer. Each environment sits in its own VPC Service
Controls perimeter, created in dry-run mode.

## Before you start

Run from Cloud Shell as a jmarcellis.com organization administrator who also
has Billing Account User on the billing account.

1. Create the Google groups referenced in the tfvars:
   `gcp-fnol-admins@`, `gcp-fnol-developers@`, `gcp-fnol-sre@` (all `@jmarcellis.com`).
2. Collect IDs:
   ```sh
   gcloud organizations list                                   # org_id
   gcloud organizations describe ORG_ID \
     --format='value(owner.directoryCustomerId)'               # directory_customer_id
   gcloud billing accounts list                                # billing_account
   ```
3. If `jmfnol` is taken as a project prefix, choose another and use it in every stage.

## Apply order

```sh
# Stage 0: local state first
cd infra/0-bootstrap
cp terraform.tfvars.example terraform.tfvars   # fill in
terraform init && terraform apply

# Move stage 0 state into the bucket it just created
cat > backend.tf <<'EOF'
terraform {
  backend "gcs" {
    prefix = "0-bootstrap"
  }
}
EOF
terraform init -migrate-state -backend-config=../backend.auto.hcl

# Stage 1
cd ../1-org
cp terraform.tfvars.example terraform.tfvars   # fnol_folder and SA come from stage 0 outputs
terraform init -backend-config=../backend.auto.hcl
terraform apply

# Stage 2, once per environment
cd ../2-env
for ENV in dev stg prd; do
  terraform init -reconfigure -backend-config=../backend.auto.hcl -backend-config="prefix=2-env/$ENV"
  terraform apply -var-file=envs/$ENV.tfvars
done
```

Set `billing_account` in each `envs/*.tfvars` first. To reach the in-house claims
and policy systems over HA VPN, fill in `onprem_cidrs` and `onprem_vpn`. The
pre-shared keys are generated and stored in Secret Manager in `jmfnol-sec-ENV`.

## Manual steps after apply

| Step | Where | Why |
| --- | --- | --- |
| Enable the Claude models (Haiku, Sonnet, Opus) in Vertex AI Model Garden and accept the terms | Each `jmfnol-ai-ENV` project | Claude on Vertex AI needs a per-project enablement that Terraform cannot accept for you. Gemini needs nothing. |
| Request Vertex AI quota for both providers | Each `jmfnol-ai-ENV` | Default quotas are too low for production intake volume. |
| Send `nat_egress_ips` output to Guidewire Cloud and other partners | Stage 2 output | Partners allowlist our fixed egress addresses. |
| Review VPC-SC dry-run violations for two weeks, then set `perimeter_enforced = true` | Logs Explorer, `protoPayload.metadata.dryRun=true` | Enforcing without review can block legitimate calls. |
| Link the Customer Engagement Suite (Agent Assist) instance | `jmfnol-ai-ENV` | Done in Phase 2, when the copilot is built. |

## Notes

- Data Access audit logs are on for Firestore, GCS, BigQuery, Cloud SQL, Vertex AI,
  KMS and Secret Manager. That is required for claim data, and it adds logging cost.
- CMEK keys have `prevent_destroy`. Destroying an environment requires removing that first, on purpose.
- Egress currently allows HTTPS to any destination through NAT. Phase 4 replaces this
  with Secure Web Proxy and an FQDN allowlist.
