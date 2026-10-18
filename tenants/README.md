# Tenant configuration

One JSON file per carrier tenant: `tenants/<tenant-id>.json`. The tenant id is the `id` field, or the file name if `id` is absent
(letters, digits, `-`, `_`). Files are loaded at boot into the versioned `tenant_configs` table; a changed file creates a new version,
an unchanged file is a no-op. Runtime edits go through `ctx.tenants.put(tenantId, config, actor)`.

```json
{ "id": "northwind", "displayName": "Northwind Mutual (fictional)" }
```

Validation runs through `ctx.tenants.addValidator(fn)`; the Workflow & Rules team owns the full schema (branding, lines of business,
intake questions, rules, regulatory timers). Use synthetic carriers only.
