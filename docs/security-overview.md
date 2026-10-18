# FNOL Platform: security overview

For carrier security, privacy and compliance reviewers. Version 1 (proof of concept), October 2026.

The FNOL Platform is a multi-tenant, commercial off-the-shelf product for first notice of loss. Claimants, CSRs and partners report a loss, and the platform captures it, triages it and routes it. Then it hands the claim to your core claims system. Coverage decisions, reserves and payments stay in your system of record.

This page summarises how we protect your data. Items marked **(planned)** are designed but not yet available in the proof of concept. Everything else is in the product today. The supporting design documents are:

- [Threat model](../architecture/threat-model.md): STRIDE analysis, ranked risks and the security backlog
- [Data-protection design](../architecture/data-protection.md): PII inventory, encryption, key management, retention and log redaction
- [Compliance mapping](compliance-mapping.md): GLBA Safeguards Rule, NAIC Insurance Data Security Model Law (#668), state claim-handling timelines and SOC 2 CC6, CC7 and CC8

## Tenant isolation

Each carrier is a separate tenant. Your tenant is taken from your signed access token, never from request data. Requests that try to name another tenant are refused.

Every stored record is tagged with its tenant. The data layer adds the tenant filter to queries automatically, so application code cannot forget it. Each tenant's personal data is encrypted with that tenant's own key. Even if a record were exposed to another tenant, it could not be read.

Events, webhooks and audit trails are scoped per tenant. An automated security test suite that checks cross-tenant access on every API route is being added as features land **(in progress)**. We review isolation continuously: our threat model records the limits we found and the fixes scheduled for the next release.

## Identity and access

- **Authentication.** Access uses signed bearer tokens that expire. In production, tokens come from your identity provider over OIDC, so your MFA and joiner/leaver processes apply **(planned)**. The proof of concept uses development tokens that are disabled in production mode.
- **Authorization.** Every API operation declares the roles allowed to call it, and the platform enforces this before any business logic runs. The roles are claimant, CSR, adjuster, supervisor, carrier administrator and integration. Claimants are limited to their own claims **(planned)**.
- **Platform operator access** to a tenant is restricted to a dedicated operator role. Each such access will be recorded in your audit trail **(planned)**.

## Protecting personal information

- **Inventory.** Every personal-data field in our data model is flagged in the published schemas: names, date of birth, contact details, addresses, driver's licence, licence plate, loss narrative, injury description, notes and audit IP addresses.
- **Encryption at rest.** These fields are encrypted individually with AES-256-GCM under a tenant-specific key before storage. Search on encrypted fields uses keyed blind indexes.
- **Key management.** Keys are never stored in source control. Hosted deployments will use a dedicated Cloud KMS key per tenant, with scheduled rotation and crypto-shredding at off-boarding **(planned)**.
- **In transit.** Hosted deployments use TLS everywhere: client to platform, platform to your systems, and platform to AI providers **(planned with hosted deployment)**.
- **No personal data in events or webhooks.** Integration events carry identifiers, codes and scores only, and this cannot be switched on by configuration. Webhooks are signed with HMAC-SHA256 **(planned)**.
- **Logs** are structured and filter out personal-data fields by name. We are widening the filter to cover more free-text fields **(planned)**.
- **Retention.** You set retention per tenant. The platform deletes abandoned intake sessions and closed claims on schedule, and supports legal hold **(planned)**.

## AI safeguards

AI assists and a person confirms. Every AI result shows the provider, model, confidence and an explanation. Results below the confidence threshold are marked unconfirmed and sent for human review. AI never changes a claim's status on its own **(planned)**.

- **Your choice of provider.** You can run fully in-platform with the built-in deterministic engine, or enable approved cloud models in the region you choose.
- **Data sent to models.** We send only what each task needs. Personal data is masked by default before it reaches an external model, and we use provider terms that exclude training on your data **(planned)**.
- **Untrusted content.** Uploaded documents are treated as data, never as instructions. Model output must match a strict schema and be grounded in the source document **(planned)**.
- **Resilience.** If a model is unavailable, intake continues and the claim is flagged for review **(planned)**.

## Audit and accountability

Every configuration change is recorded in an append-only audit log. Claim state changes, routing overrides and sensitive reads such as opening a document are recorded the same way as those features land **(planned)**. The log is hash-chained per tenant, so any alteration is detectable. Your supervisors and administrators can query and verify it through the API.

Configuration changes are versioned and audited, so you can see who changed a rule and when.

## Regulatory support

The platform supports your programme. It does not replace it.

- **Information security programme.** We provide the materials your GLBA and NAIC #668 programme needs from a service provider: threat model, controls mapping and incident cooperation **(planned runbook)**.
- **Claim-handling deadlines.** You configure acknowledgment, contact and decision deadlines by state and line of business. The platform tracks each claim against them, warns before a due date and escalates on breach **(planned)**. Example values for WI, IL and MI are illustrative and must be confirmed by your counsel.
- **SOC 2.** Controls are mapped to the SOC 2 logical-access (CC6), operations (CC7) and change-management (CC8) criteria, with evidence locations. A formal SOC 2 examination is **(planned)** before general availability.

## How we build

- The platform core has no third-party runtime dependencies, which reduces supply-chain risk.
- Every change is ticketed, reviewed against acceptance criteria that include tenant isolation and personal-data handling, and covered by automated tests.
- All demo and test data is synthetic. No real people, policies or carrier data are used in development.

Questions or a security assessment request: contact your account team, who will connect you with the security team.
