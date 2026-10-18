# Carrier configuration guide

Audience: a carrier configuration analyst or carrier admin who needs to change how the platform behaves without a code change. Everything here was checked against the schema `architecture/contracts/domain/TenantConfig.schema.json`, the config module (`src/modules/config/`), the rules, claims, intake, AI and integrations modules, and the two demo tenant files. Both tenants are fictional: Aurelia Mutual (`tenants/aurelia-mutual.json`, personal auto and homeowners, WI and IL, English and Spanish) and Kestrel Point Insurance (`tenants/kestrel-point.json`, personal auto and commercial auto, MI, English). Regulatory deadlines in these files are demo values labelled "Illustrative, not legal advice".

Snippets below are copied verbatim from the tenant files. The `file:line` tag above each one says where it lives.

## 1. How configuration works

- One JSON document per carrier, `tenants/<tenantId>.json`. It is the whole product configuration: branding, lines of business, intake questions, rules, queues, regulatory timers, notifications, integrations and AI.
- The document is validated against the TenantConfig schema (unknown keys are rejected, see section 8) and then against semantic checks (for example a rule that routes to a queue that does not exist).
- Every save creates a new numbered version. History is kept, each save is audited (`tenant.config.updated`), and the change is published on the event bus with the list of changed sections.
- Top-level sections and who reads them:

| Section | Required | Read by |
| --- | --- | --- |
| `tenantId`, `version`, `displayName` | yes | identity |
| `claimNumberPrefix` (2 to 5 capitals), `timeZone`, `locales` | no | claim numbers, UI |
| `branding` (`primaryColor` required) | yes | claimant and CSR UIs, via `GET /api/v1/config/public` |
| `lobs` | yes (at least 1) | intake, validation of everything else |
| `questionSets` | yes | intake question engine |
| `rules` | yes (may be empty) | rules engine at four stages |
| `queues`, `defaultQueue` | yes (at least 1 queue) | routing |
| `fastTrack`, `severityBands` | no | straight-through decision, triage bands |
| `timers`, `holidays` | `timers` yes | claims timers |
| `notifications`, `integrations` | no | see sections 11 and 12 |
| `ai` | yes (`provider`) | AI cascade |
| `security`, `evidence` | no | `security.sessionTtlMinutes` is read by intake; `evidence.maxUploadBytes` caps uploads (default 10 MB, maximum 15 MB) |

## 2. Where the file goes and when it loads

Put the file in `tenants/`. Name the file after the tenant id: the registry key is the file's `id` field, or the file name when there is none (the demo files have only `tenantId`, so the file name is the key), and `tenantId` must match `^[a-z][a-z0-9-]{2,39}$`. At every server start the platform reads every `tenants/*.json` and applies it **only once** (seed-once, `loadDir` in `src/core/tenants.mjs`): a file is stored when the tenant has no stored configuration yet, or when the file's top-level `seedVersion` (missing counts as 0) is higher than the stored configuration's. Otherwise the file is skipped and the boot log says so (`tenant config skipped`), so a console save survives a restart. Versions applied at boot are recorded with actor `boot`.

To push a changed file to a tenant that already has a stored configuration, raise `seedVersion` in the file. Caution, verified by running it: `seedVersion` is not in the TenantConfig schema, so the config validator rejects it (`additionalProperties`, 422) on `POST /config/validate` and `PUT /config`. Boot accepts it, but once the stored copy carries `seedVersion`, every console save of that tenant fails until the key is removed from the saved document. The two demo files do not set it, so today a restart never overwrites a console edit. A contract change was requested (section 10).

## 3. Section-by-section walkthrough

### 3.1 Identity and locale

Aurelia, `tenants/aurelia-mutual.json:2-11`:

```json
  "$schema": "../architecture/contracts/domain/TenantConfig.schema.json",
  "tenantId": "aurelia-mutual",
  "version": 1,
  "displayName": "Aurelia Mutual (fictional)",
  "claimNumberPrefix": "AUR",
  "timeZone": "America/Chicago",
  "locales": [
    "en",
    "es"
  ],
```

- `$schema` is an editor hint only.
- `claimNumberPrefix` is used for claim numbers (default: derived from the tenant id).
- `locales` lists the languages offered. Any text field that is an "I18nText" can be either a plain string or a map of locale to string. Kestrel uses plain strings, Aurelia uses `en` and `es` maps. Locale keys must match `^[a-z]{2}(-[A-Z]{2})?$`.

### 3.2 Branding

Aurelia, `tenants/aurelia-mutual.json:12-32`:

```json
  "branding": {
    "primaryColor": "#1f5f4a",
    "accentColor": "#e0a526",
    "fontFamily": "Georgia, serif",
    "supportPhone": "(555) 010-0142",
    "supportEmail": "claims@aurelia-mutual.example",
    "legalFooter": {
      "en": "Aurelia Mutual is a fictional carrier used for demonstration only.",
      "es": "Aurelia Mutual es una aseguradora ficticia usada solo para demostracion."
    },
    "fraudWarning": {
      "WI": {
        "en": "Illustrative notice (WI): giving false information on a claim may be a crime.",
        "es": "Aviso ilustrativo (WI): dar informacion falsa en un reclamo puede ser un delito."
      },
      "IL": {
        "en": "Illustrative notice (IL): giving false information on a claim may be a crime.",
        "es": "Aviso ilustrativo (IL): dar informacion falsa en un reclamo puede ser un delito."
      }
    }
  },
```

Only `primaryColor` is required. Colors must be `#rrggbb`. `fraudWarning` is keyed by state code and shows the state notice. `logoUrl`, if used, is a relative path to a synthetic asset. The UIs read this through `GET /api/v1/config/public`, which returns only `tenantId`, `displayName`, `branding`, `lobs` and `locales`; rules, queues and AI settings are never exposed there.

### 3.3 Lines of business

Kestrel, `tenants/kestrel-point.json:63-102`:

```json
    {
      "id": "commercial_auto",
      "enabled": true,
      "label": "Commercial auto",
      "acordLobCd": "AUTOB",
      "states": [
        "MI"
      ],
      "channels": [
        "csr_phone",
        "api"
      ],
      "lossTypes": [
        {
          "id": "collision",
          "label": "Collision",
          "causes": [
            "collision",
            "single_vehicle",
            "hit_and_run"
          ]
        },
        {
          "id": "cargo_loss",
          "label": "Cargo loss",
          "causes": [
            "theft",
            "other"
          ]
        },
        {
          "id": "liability",
          "label": "Third-party liability",
          "causes": [
            "liability_bodily_injury",
            "liability_property_damage"
          ]
        }
      ]
    }
```

Fields: `id` (lowercase, digits, underscore, 3 to 40 characters), `enabled`, `label`, `acordLobCd` (for example AUTOP, HOME, AUTOB), `states` (two-letter capitals), `channels`, and `lossTypes[]` with `id`, `label` and `causes[]`. Causes must come from the platform list in `common.schema.json` (`collision`, `collision_animal`, `single_vehicle`, `hit_and_run`, `glass`, `theft`, `vandalism`, `fire`, `lightning`, `wind`, `hail`, `water_weather`, `water_plumbing`, `flood`, `freeze`, `falling_object`, `liability_bodily_injury`, `liability_property_damage`, `other`). Channels come from `claimant_web`, `claimant_mobile`, `csr_phone`, `agent_portal`, `api`, `email`, `partner`. Note that `lossTypes[].id` values are free text, but question sets and rules refer to them, so spelling matters.

Runtime effect (intake service): a line of business with `enabled: false`, or one missing from `lobs`, is refused with `unsupported_lob`; if `channels` is non-empty and the intake channel is not listed, the claim is refused with `unsupported_channel`.

### 3.4 Question sets

Aurelia, a conditional question, `tenants/aurelia-mutual.json:235-255`:

```json
        {
          "id": "other_party_info",
          "text": {
            "en": "Other party details",
            "es": "Datos de la otra parte"
          },
          "type": "party",
          "showIf": {
            "fact": "answers.other_party_involved",
            "op": "eq",
            "value": true
          },
          "requiredIf": {
            "fact": "answers.other_party_involved",
            "op": "eq",
            "value": true
          },
          "pii": true,
          "order": 60,
          "section": "parties"
        },
```

A question set has `id`, `lob`, `version` and at least one question. Optional `lossTypes` and `channels` narrow when the set applies. The service picks the most specific match: a set with `lossTypes` scores 2, with `channels` scores 1, ties go to the higher `version`. A set with neither is the general set for the line of business. Question fields: `id` (`^[a-z][a-z0-9_]{1,63}$`), `text`, `type` (one of `text`, `longtext`, `number`, `currency`, `boolean`, `date`, `time`, `datetime`, `select`, `multiselect`, `address`, `location`, `phone`, `email`, `vin`, `party`, `vehicle`, `media`, `disclosure`), `required`, `requiredIf`, `showIf`, `options` (needed for `select` and `multiselect`), `validation` (`min`, `max`, `pattern`, `maxLength`, `notInFuture`), `pii`, `mapsTo`, `aiAssist`, `order`, `section`, `help`.

### 3.5 Rules

Kestrel, `tenants/kestrel-point.json:636-657`:

```json
    {
      "id": "RT-CA-NO-STP",
      "name": "Commercial auto is never fast tracked",
      "stage": "routing",
      "priority": 5,
      "appliesTo": {
        "lobs": [
          "commercial_auto"
        ]
      },
      "when": true,
      "then": [
        {
          "type": "deny_fast_track",
          "reason": "commercial lines are never fast tracked"
        },
        {
          "type": "add_flag",
          "flag": "commercial_review"
        }
      ]
    },
```

Every rule has `id` (capitals, digits and dashes, starting with a capital, 3 to 41 characters), `stage`, `when` (a condition) and `then` (at least one action). Optional: `name`, `description`, `enabled` (default true), `priority` (default 100, lower runs first), `stopOnMatch`, and `appliesTo` (`lobs`, `states`, `lossTypes`, `effectiveFrom`, `effectiveTo`). Stages, in order: `intake`, `triage`, `routing`, `post_routing`. Rules for a stage run by ascending priority then id; all matching rules fire unless one with `stopOnMatch` matches. Section 4.4 covers conditions and actions.

### 3.6 Queues and fast track

Aurelia, `tenants/aurelia-mutual.json:947-967` and `1049-1058`:

```json
    {
      "id": "fast_track",
      "label": {
        "en": "Fast track",
        "es": "Via rapida"
      },
      "lobs": [
        "personal_auto",
        "homeowners"
      ],
      "skills": [
        "stp"
      ],
      "adjusters": [
        "adj-aur-101",
        "adj-aur-102"
      ],
      "assignment": "round_robin",
      "slaHours": 4,
      "maxSeverity": 30
    },
```

```json
  "fastTrack": {
    "enabled": true,
    "maxSeverity": 30,
    "maxFraudScore": 25,
    "maxEstimate": {
      "amount": 2500,
      "currency": "USD"
    },
    "queue": "fast_track"
  },
```

See sections 4.5 and 4.6.

### 3.7 Timers and holidays

Aurelia, `tenants/aurelia-mutual.json:1065-1105` and `1318-1322`:

```json
    {
      "id": "WI-ACK",
      "state": "WI",
      "kind": "acknowledge",
      "duration": {
        "value": 7,
        "unit": "days"
      },
      "startOn": "claim.reported",
      "lobs": [
        "personal_auto",
        "homeowners"
      ],
      "stopOn": {
        "taskType": "acknowledge_claimant"
      },
      "warnBefore": {
        "value": 2,
        "unit": "days"
      },
      "onBreach": [
        {
          "type": "add_flag",
          "flag": "ack_breach"
        },
        {
          "type": "notify",
          "template": "timer_breach_internal"
        },
        {
          "type": "add_task",
          "task": {
            "type": "timer_breach_followup",
            "title": "Resolve breached deadline (ack_breach)",
            "dueInHours": 8,
            "queue": "auto_physical_damage"
          }
        }
      ],
      "citation": "WI acknowledgement deadline (demo value 7 days). Illustrative, not legal advice."
    },
```

```json
  "holidays": [
    "2026-11-26",
    "2026-12-25",
    "2027-01-01"
  ],
```

See section 4.2.

### 3.8 Notifications, integrations, AI, security

Aurelia, `tenants/aurelia-mutual.json:1323-1352`:

```json
  "notifications": {
    "claimant": {
      "channels": [
        "email",
        "sms"
      ],
      "onEvents": [
        "claim.reported",
        "claim.routed",
        "claim.status.changed"
      ]
    },
    "internal": {
      "onEvents": [
        "claim.timer.breached",
        "claim.routed"
      ],
      "emails": [
        "supervisors@aurelia-mutual.example"
      ]
    },
    "webhooks": {
      "enabled": true,
      "allowedHosts": [
        "hooks.aurelia-mutual.example"
      ],
      "signingAlgorithm": "hmac-sha256",
      "includePii": false
    }
  },
```

Aurelia, `tenants/aurelia-mutual.json:1353-1368`:

```json
  "integrations": {
    "policyPort": {
      "adapter": "mock-pas",
      "settings": {
        "fieldMapProfile": "mapping-a",
        "policyNumberFormat": "AUR-########"
      }
    },
    "claimsPort": {
      "adapter": "core-claims-suite",
      "pushOn": "claim.routed",
      "settings": {
        "fieldMapProfile": "mapping-a"
      }
    }
  },
```

Aurelia, `tenants/aurelia-mutual.json:1369-1409`:

```json
  "ai": {
    "provider": "cascade",
    "cascade": [
      {
        "provider": "local",
        "minConfidence": 0.75
      },
      {
        "provider": "vertex-claude",
        "model": "claude-sonnet",
        "minConfidence": 0.6,
        "tasks": [
          "extract_narrative",
          "summarize",
          "next_question",
          "fraud_signals"
        ]
      }
    ],
    "tasks": {
      "next_question": {
        "enabled": true,
        "threshold": 0.7
      },
      "extract_narrative": {
        "enabled": true,
        "threshold": 0.7
      },
      "fraud_signals": {
        "enabled": true,
        "threshold": 0.65
      },
      "summarize": {
        "enabled": true
      }
    },
    "region": "us-central1",
    "redactPiiBeforeModel": true,
    "maxTokensPerClaim": 40000,
    "humanConfirmRequired": true
  },
```

Aurelia, `tenants/aurelia-mutual.json:1410-1414`:

```json
  "security": {
    "piiKeyRef": "kms://demo/aurelia-mutual",
    "sessionTtlMinutes": 60,
    "dataRetentionDays": 2555
  }
```

Instant acknowledgment (REQ-12): when `notifications.claimant.channels` is non-empty and `onEvents` is absent or includes `claim.reported`, every new claim is acknowledged through the first channel: the platform records an audit entry, a completed `acknowledge_claimant` task (which also meets an `acknowledge` timer whose `stopOn` is that task type) and a `claim.acknowledged` event (`acknowledgeClaim` in `src/modules/claims/service.mjs`). In this PoC nothing is actually sent (`delivery: recorded_only`). With no channel configured nothing is recorded. The KPI `median_minutes_to_acknowledgment` reads that event first, then the timer's met time.

See sections 4.7 and 4.8. In `security`, only `sessionTtlMinutes` (intake session lifetime) is read by the code paths this guide checked; `piiKeyRef` is a reference to a data key, never the key itself.

## 4. How-tos

### 4.1 Add or change a line of business

1. Add an entry to `lobs` (copy Kestrel's `commercial_auto` shown in 3.3). Give it `id`, `enabled: true`, `label`, `states`, and loss types.
2. Add at least one question set whose `lob` is that id. The validator warns (does not fail) when an enabled line of business has no question set, but intake then has nothing to ask.
3. Add the id to `lobs` on every queue that should serve it (`queues[].lobs`; validator error `unknown_lob` if misspelled).
4. Add rules with `appliesTo.lobs`, and timers with `lobs`, for the new line.
5. States you list in `lobs[].states` become the set of states the rest of the config may refer to: a rule `appliesTo.states` or a timer `state` that no line of business serves fails with `unknown_state`.

To switch a line off without deleting anything, set `enabled: false`.

### 4.2 Add a state regulatory timer

A timer is a deadline that starts on an event and is met by another event. Kestrel, `tenants/kestrel-point.json:1056-1098`:

```json
    {
      "id": "MI-DECIDE-PA",
      "state": "MI",
      "kind": "decide",
      "duration": {
        "value": 30,
        "unit": "days"
      },
      "startOn": "claim.reported",
      "lobs": [
        "personal_auto"
      ],
      "stopOn": {
        "toStatus": [
          "closed",
          "withdrawn"
        ]
      },
      "warnBefore": {
        "value": 5,
        "unit": "days"
      },
      "onBreach": [
        {
          "type": "add_flag",
          "flag": "decision_breach"
        },
        {
          "type": "notify",
          "template": "timer_breach_internal"
        },
        {
          "type": "add_task",
          "task": {
            "type": "timer_breach_followup",
            "title": "Resolve breached deadline (decision_breach)",
            "dueInHours": 24,
            "queue": "personal_auto_claims"
          }
        }
      ],
      "citation": "MI personal auto decision deadline (demo value 30 days). Illustrative, not legal advice."
    },
```

Required: `id`, `state` (two-letter), `kind` (`acknowledge`, `contact` or `decide`), `duration` (`value` at least 1, `unit` of `hours`, `days` or `business_days`).

Optional and what the code does with them:
- `startOn`: event type that starts the timer; default `claim.reported`. A timer is created only when the claim's risk state equals `state` and, if `lobs` is given, the claim's line of business is listed.
- `stopOn`: marks the timer met. Use `toStatus` (claim status changes, Kestrel above), `taskType` (a completed task of that type, Aurelia's `acknowledge_claimant`) or `event`. Allowed `toStatus` values: `reported`, `validating`, `triaged`, `assigned`, `fast_tracked`, `in_review`, `pending_info`, `closed`, `withdrawn`.
- `warnBefore`: raises a due-soon warning that long before the deadline.
- `onBreach`: actions applied when the deadline passes (same action shapes as rules; `add_flag`, `notify` and `add_task` are what the demo tenants use). Queue and timer names are checked.
- `citation`: free text. The validator warns if it does not contain the word "illustrative", because demo deadlines must say "Illustrative, not legal advice".
- `business_days` skips Saturdays, Sundays and every date in the top-level `holidays` array (ISO dates, `YYYY-MM-DD`). `days` means 24-hour days.

Example, an Illinois two-business-day acknowledgement, `tenants/aurelia-mutual.json:1191-1231`:

```json
    {
      "id": "IL-ACK",
      "state": "IL",
      "kind": "acknowledge",
      "duration": {
        "value": 2,
        "unit": "business_days"
      },
      "startOn": "claim.reported",
      "lobs": [
        "personal_auto",
        "homeowners"
      ],
      "stopOn": {
        "taskType": "acknowledge_claimant"
      },
      "warnBefore": {
        "value": 1,
        "unit": "business_days"
      },
      "onBreach": [
        {
          "type": "add_flag",
          "flag": "ack_breach"
        },
        {
          "type": "notify",
          "template": "timer_breach_internal"
        },
        {
          "type": "add_task",
          "task": {
            "type": "timer_breach_followup",
            "title": "Resolve breached deadline (ack_breach)",
            "dueInHours": 8,
            "queue": "auto_physical_damage"
          }
        }
      ],
      "citation": "IL acknowledgement deadline (demo value 2 business days). Illustrative, not legal advice."
    },
```

To add a timer for a new state, the state must already be served by a line of business (3.3), and the timer's `lobs` must all serve it (`state_not_served` otherwise).

### 4.3 Show a question conditionally (showIf and requiredIf)

`showIf` hides a question until a condition is true; `requiredIf` makes it mandatory under a condition. Kestrel, `tenants/kestrel-point.json:383-399`:

```json
        {
          "id": "hazmat_involved",
          "text": "Was hazardous material involved?",
          "type": "boolean",
          "showIf": {
            "fact": "answers.cargo_involved",
            "op": "eq",
            "value": true
          },
          "requiredIf": {
            "fact": "answers.cargo_involved",
            "op": "eq",
            "value": true
          },
          "order": 55,
          "section": "cargo"
        },
```

Facts available to question conditions are `answers.<questionId>`, `session.*` and `policy.*`. The validator enforces two rules on top of the schema:
- `answers.<id>` must name a question in the same question set (`unknown_question`).
- A question may not depend on its own answer (`self_reference`).

Comparison syntax is the condition language in 4.4. A question can also be made mandatory by a rule at the `intake` stage with the `require_question` action (Aurelia `IN-OTHER-PARTY`, below).

### 4.4 Write a rule (conditions and actions)

A condition is either a combinator or a leaf. Combinators: `all` (array, at least 1), `any` (array, at least 1), `not` (one condition). A leaf is `{ "fact": "...", "op": "...", "value": ... }`. The literal `true` is also accepted as `when` (the demo "default queue" rules use it). Fact paths start with one of `claim`, `loss`, `policy`, `coverage`, `triage`, `parties`, `vehicles`, `property`, `evidence`, `answers`, `session`, `tenant`, `now`, for example `loss.cause`, `triage.severityScore`, `coverage.outcome`, `vehicles[*].drivable`. Operators (16): `eq`, `ne`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`, `between`, `exists`, `missing`, `contains`, `matches`, `any_eq`, `count_gte`, `within_days`. `in`, `nin` and `between` take an array value; `exists` and `missing` take none.

Action types (13): `route_queue` (needs `queue`), `assign_adjuster` (`adjusterId`), `fast_track`, `deny_fast_track` (`reason`), `add_flag` (`flag`), `add_task` (`task` with `type` or `title`, `dueInHours`, `queue`), `require_question` (`questionId`), `add_severity` (`points`, -100 to 100), `set_complexity` (`complexity`: `low`, `medium`, `high`), `refer_siu` (`reason`), `start_timer` (`timerId`), `notify` (`template`), `block_submit` (`reason`). The routing actions `route_queue`, `assign_adjuster`, `fast_track` and `deny_fast_track` are rejected at the `intake` stage.

Intake stage example, Aurelia `tenants/aurelia-mutual.json:612-633`:

```json
    {
      "id": "IN-OTHER-PARTY",
      "name": "Collect other party when involved",
      "stage": "intake",
      "priority": 10,
      "when": {
        "fact": "answers.other_party_involved",
        "op": "eq",
        "value": true
      },
      "then": [
        {
          "type": "require_question",
          "questionId": "other_party_info"
        }
      ],
      "appliesTo": {
        "lobs": [
          "personal_auto"
        ]
      }
    },
```

Routing precedence, from the routing code: the first `route_queue` wins (so give specific rules a low priority number and the catch-all default a high one, as the demo tenants do with 10 versus 90); `deny_fast_track` beats `fast_track`; an approved fast track beats default queues. If no rule picks a queue, `defaultQueue` is used, otherwise the first non-fast-track queue that serves the line of business.

### 4.5 Change a queue

Aurelia, `tenants/aurelia-mutual.json:947-967`, is shown in 3.6. Fields: `id` (lowercase, digits, underscore, 2 to 41 characters), `label`, `lobs`, `skills`, `adjusters` (adjuster ids), `assignment`, `slaHours`, `maxSeverity`.

- `assignment`: `round_robin` (default; rotates through `adjusters`), `least_loaded` (fewest currently assigned claims in the queue) or `manual` (no automatic assignee).
- Referential checks: every queue id used in a rule action, a timer `onBreach` action or `fastTrack.queue` must exist; `assign_adjuster` must name an adjuster listed in some queue.
- Verified: `lobs`, `adjusters` and `assignment` change runtime behaviour. `skills`, `slaHours` and the queue-level `maxSeverity` are descriptive in this release: a search of `src/` finds no runtime code that reads them, so do not rely on them to change routing.
- To add a queue: add it to `queues`, then add or edit a `route_queue` rule to send claims to it. Removing a queue that rules still name fails validation with `unknown_queue`.

### 4.6 Configure the straight-through (STP) rule

STP has two parts that must agree: a routing-stage rule that asks for it, and the tenant `fastTrack` limits that guard it.

The rule, Kestrel, `tenants/kestrel-point.json:737-782`:

```json
    {
      "id": "RT-FT-GLASS",
      "name": "Straight-through: glass only",
      "stage": "routing",
      "priority": 50,
      "appliesTo": {
        "lobs": [
          "personal_auto"
        ]
      },
      "when": {
        "all": [
          {
            "fact": "loss.cause",
            "op": "eq",
            "value": "glass"
          },
          {
            "fact": "triage.severityScore",
            "op": "lt",
            "value": 15
          },
          {
            "fact": "coverage.outcome",
            "op": "eq",
            "value": "covered"
          },
          {
            "not": {
              "fact": "answers.prior_damage",
              "op": "eq",
              "value": true
            }
          }
        ]
      },
      "then": [
        {
          "type": "fast_track"
        },
        {
          "type": "route_queue",
          "queue": "fast_track"
        }
      ]
    },
```

The limits, Kestrel, `tenants/kestrel-point.json:959-968`:

```json
  "fastTrack": {
    "enabled": true,
    "maxSeverity": 15,
    "maxFraudScore": 10,
    "maxEstimate": {
      "amount": 900,
      "currency": "USD"
    },
    "queue": "fast_track"
  },
```

How it decides (from `src/modules/rules/routing.js`): when a rule emits `fast_track`, the claim is fast tracked only if no `deny_fast_track` fired and all of these hold: `fastTrack.enabled` is not false; coverage outcome is `covered`; triage did not mark it ineligible; severity score is not above `maxSeverity` (default 25); fraud score is not above `maxFraudScore` (default 20); the estimate is not above `maxEstimate.amount`. When blocked, the decision records a reason such as "fast track blocked: severity 40 above fast-track limit 15", and the claim goes to the normal queue. Kestrel's `RT-NO-STP-THEFT` (`tenants/kestrel-point.json:594-617`) shows how to forbid STP for a cause:

```json
    {
      "id": "RT-NO-STP-THEFT",
      "name": "Theft never fast tracked",
      "stage": "routing",
      "priority": 25,
      "when": {
        "fact": "loss.cause",
        "op": "in",
        "value": [
          "theft",
          "vandalism"
        ]
      },
      "then": [
        {
          "type": "deny_fast_track",
          "reason": "theft needs review"
        },
        {
          "type": "add_flag",
          "flag": "theft_review"
        }
      ]
    },
```

Key points: the rule's own `triage.severityScore` threshold (`lt 15` in Kestrel, `lt 30` in Aurelia) and the `fastTrack.maxSeverity` are two separate gates, and the stricter one wins, so change them together. `fastTrack.queue` (default `fast_track`) must exist in `queues`. Aurelia's glass rule, `tenants/aurelia-mutual.json:768-806`, is the same pattern with a different threshold:

```json
    {
      "id": "RT-FT-GLASS",
      "name": "Straight-through: glass",
      "stage": "routing",
      "priority": 50,
      "appliesTo": {
        "lobs": [
          "personal_auto"
        ]
      },
      "when": {
        "all": [
          {
            "fact": "loss.cause",
            "op": "eq",
            "value": "glass"
          },
          {
            "fact": "triage.severityScore",
            "op": "lt",
            "value": 30
          },
          {
            "fact": "coverage.outcome",
            "op": "eq",
            "value": "covered"
          }
        ]
      },
      "then": [
        {
          "type": "fast_track"
        },
        {
          "type": "route_queue",
          "queue": "fast_track"
        }
      ]
    },
```

### 4.7 Change AI settings

Kestrel, `tenants/kestrel-point.json:1192-1229`:

```json
  "ai": {
    "provider": "cascade",
    "cascade": [
      {
        "provider": "local",
        "minConfidence": 0.85
      },
      {
        "provider": "vertex-gemini",
        "model": "gemini-flash",
        "minConfidence": 0.7,
        "tasks": [
          "extract_narrative",
          "summarize"
        ]
      }
    ],
    "tasks": {
      "next_question": {
        "enabled": false
      },
      "extract_narrative": {
        "enabled": true,
        "threshold": 0.85
      },
      "fraud_signals": {
        "enabled": true,
        "threshold": 0.8
      },
      "summarize": {
        "enabled": true
      }
    },
    "region": "us-east4",
    "redactPiiBeforeModel": true,
    "maxTokensPerClaim": 20000,
    "humanConfirmRequired": true
  },
```

- `ai.provider` is required: `local`, `vertex-claude`, `vertex-gemini` or `cascade`. With `cascade`, `ai.cascade[]` must have at least one entry (`missing_cascade` error), each with `provider`, optional `model`, `minConfidence` (0 to 1) and `tasks` (limits that entry to those tasks; empty means all). Entries run in order; the first answer whose confidence meets its threshold wins. The platform always appends the local provider as the last resort. The validator warns if the first entry is not `local`.
- `ai.tasks.<task>`: `enabled: false` turns the task off for the tenant; `threshold` overrides the confidence required; `provider` and `model` force a provider for that task.
- Task names the runtime recognises (`src/ai/schemas.mjs`): `extract_narrative`, `extract_document`, `classify_photo`, `severity`, `fraud_signals`, `subrogation`, `summarize`, `next_best_actions`. The schema comments mention `next_question`, and both demo tenants set it, but no runtime AI task has that name, so that entry has no effect today. Use the names above.
- Input showing an injury, fatality, litigation or catastrophe code is a "hard escalation": the chain is limited to the strongest cloud entry (or the last cloud entry if none is marked strong), then `local`.
- Question-level `aiAssist: true` lets AI prefill that answer from a narrative or documents.
- Three of the safety settings are read on every AI call (`src/ai/cascade.mjs`, from the tenant's `ai` block):
  - `humanConfirmRequired: true` marks every result `unconfirmed: true`, including high-confidence ones that return early. Unset or false leaves results as they were (results below the final threshold are still marked unconfirmed).
  - `redactPiiBeforeModel`: cloud providers always receive redacted input and the setting cannot lower that. An explicit `true` also redacts input for the local provider and for injected providers; an explicit `false` is honoured for the local provider only.
  - `maxTokensPerClaim`: tokens already spent on the claim (input plus output, summed from the tenant's AI inference log by claim id) are checked before each cloud call. At or over the limit, cloud entries are skipped, the local provider answers, and the result is marked `unconfirmed`. Fail closed: with a limit set but no claim id on the call, cloud calls are skipped. The check is best-effort under concurrency: two simultaneous calls on one claim can each pass the check before either is logged, so the limit can be overshot by in-flight calls.
- `region` is still not read by any code (the Vertex Claude client is created with region `global`, `src/ai/providers/vertex-claude.mjs`). Do not present it as a switch.
- A cloud provider that is unavailable, refuses, or returns an invalid answer is skipped and the cascade moves to the next entry, ending with `local`, which is always available. If nothing can answer, the call fails with `ai_unavailable`.

### 4.8 Webhooks and adapters

Webhook subscriptions are not part of the tenant file. They are created at runtime through the integrations API (or the Webhooks tab in the admin console) by a `tenant_admin` or `carrier_admin`.

Tenant-file settings, Aurelia `tenants/aurelia-mutual.json:1323-1352` (shown in 3.8) and Kestrel `tenants/kestrel-point.json:1148-1175`:

```json
  "notifications": {
    "claimant": {
      "channels": [
        "email"
      ],
      "onEvents": [
        "claim.reported",
        "claim.status.changed"
      ]
    },
    "internal": {
      "onEvents": [
        "claim.timer.breached",
        "claim.triaged"
      ],
      "emails": [
        "claims-leads@kestrel-point.example"
      ]
    },
    "webhooks": {
      "enabled": true,
      "allowedHosts": [
        "events.kestrel-point.example"
      ],
      "signingAlgorithm": "hmac-sha256",
      "includePii": false
    }
  },
```

Verified behaviour:
- Create: `POST /api/v1/integrations/webhooks` with `url`, `eventTypes` (for example `claim.routed`, `claim.status.changed`, or `*`; pattern `claim.` or `tenant.` followed by lowercase letters, dots and underscores), optional `description`, `active`, `retryPolicy` (`maxAttempts` 1 to 10, default 5, `backoff` `exponential`). The response returns `secret` once; store it. Rotate with `PATCH` and `{"rotateSecret": true}`. Other routes: `GET /api/v1/integrations/webhooks`, `GET|PATCH|DELETE /api/v1/integrations/webhooks/{id}`, `GET .../{id}/deliveries`, `GET /api/v1/integrations/outbox`.
- URLs must be `https`, without credentials, and not point at loopback, private, link-local or internal hosts. Plain `http` loopback is allowed only in dev mode.
- Deliveries are signed with HMAC-SHA256 of the raw body in the `X-FNOL-Signature` header; other headers are `X-FNOL-Event-Id`, `X-FNOL-Event-Type`, `X-FNOL-Delivery-Id`, `X-FNOL-Attempt`.
- `notifications.webhooks.includePii` must be `false` (validation fails with `pii_not_allowed` otherwise). Events never carry personal data.
- `notifications.webhooks.allowedHosts` is enforced (`checkAllowedHost`, `src/modules/integrations/webhooks/url-guard.mjs`). Entries are an exact host or `*.suffix`. `POST` and `PATCH` of a subscription return 422 naming the host when it is not in the list, and delivery checks it again. An empty or missing list denies every host, except in dev mode, where it allows any host and loopback. Both demo tenants list their own example host and `*.example.test` for test receivers.
- Still not read by any code: `notifications.webhooks.enabled` and `signingAlgorithm` (signing is always HMAC-SHA256).

Adapters (`integrations`), Kestrel `tenants/kestrel-point.json:1176-1191`:

```json
  "integrations": {
    "policyPort": {
      "adapter": "mock-pas",
      "settings": {
        "fieldMapProfile": "mapping-b",
        "policyNumberFormat": "KP-####-####"
      }
    },
    "claimsPort": {
      "adapter": "core-claims-suite",
      "pushOn": "claim.reported",
      "settings": {
        "fieldMapProfile": "mapping-b"
      }
    }
  },
```

- `claimsPort.adapter` selects the claims-system adapter; the only registered adapter is `core-claims-suite` (also the default). `policyPort.adapter` selects the policy-system adapter; the demo uses `mock-pas`.
- `claimsPort.pushOn` is `claim.reported`, `claim.routed` (default) or `manual`; `manual` turns off event pushes (use the push route instead).
- `claimsPort.settings.fieldMapProfile` chooses the field-mapping profile (`profileOf`, `src/modules/integrations/adapters/index.mjs`). Accepted values are `mapping-a` and `mapping-b` (also `A` and `B`); the legacy key `settings.profile` is still read when `fieldMapProfile` is absent; default `A`. Any other value is refused with 422 `invalid_adapter_settings`. Aurelia uses `mapping-a` (nested ACORD-style JSON) and Kestrel `mapping-b` (flat), and the preview route shows a different payload for each (tested in `tests/e2e/demo-script.test.mjs` beat 6). Optional `settings.target` is a URL for an HTTP receiver; if absent, the built-in in-process receiver is used. `settings.causeCodes` overrides loss-cause code mapping.
- The demo files also contain `policyNumberFormat`. It is accepted (the schema leaves `settings` open) but no code reads it.
- Routes: `GET /api/v1/integrations/adapters`, `GET /api/v1/integrations/adapters/{adapterId}/preview/{claimId}`, `POST /api/v1/integrations/adapters/{adapterId}/push/{claimId}` (returns 202).

## 5. Validate before you save: POST /api/v1/config/validate

Dry run; saves nothing. Role: `tenant_admin` or `carrier_admin`. Send the full document as the body. It always answers `200` with a report:

```json
{ "valid": false, "errors": [ { "path": "/fastTrack/queue", "code": "unknown_queue", "message": "fastTrack.queue \"ftrack\" is not a defined queue" } ], "warnings": [] }
```

`path` is a JSON pointer into your document. `errors` block a save; `warnings` do not (for example a timer citation without the word "illustrative", or an enabled line of business with no question set). This exact response was produced by running the service against Kestrel with `fastTrack.queue` changed to `ftrack`.

## 6. Save with optimistic concurrency: GET and PUT /api/v1/config with If-Match

1. `GET /api/v1/config` returns the current document and an `ETag` header holding the version, for example `"1"`. Roles: `tenant_admin`, `carrier_admin`, `supervisor`, `auditor`.
2. Edit locally.
3. `PUT /api/v1/config` with the full document and header `If-Match: 1` (quotes and a `W/` prefix are tolerated). Roles: `tenant_admin`, `carrier_admin`.

Outcomes (every row except `403` was observed against a running server; `403` is read from the code):

| Result | When |
| --- | --- |
| `200` and new `ETag` | saved as the next version |
| `200`, same version | content identical to the current version (no new version, no event) |
| `400 bad_request` | `If-Match` is not a number |
| `403 tenant_mismatch` | body `tenantId` differs from the signed-in tenant |
| `409 version_conflict` | someone saved first; message "Config is at version 2, not 1". Reload, re-apply your edit, retry |
| `422` with a validation report | validation failed; nothing saved |

Two details: the `version` inside the body is ignored and replaced by the server (the schema still requires it to be an integer of 1 or more); and `If-Match` is optional on the wire. If you omit it, the check is skipped and the last write wins, so always send it.

## 7. Admin console

Open `/admin` on the platform (`npm start`, then http://localhost:8080/admin). In dev mode on localhost a developer panel signs you in as a `tenant_admin` for either demo tenant; otherwise you must arrive through the carrier's identity provider.

Tabs: Branding, Lines of business, Locales, Questions, Rules, Timers, Webhooks, Version history, KPIs. The Rules tab also holds the straight-through limits (`fastTrack.enabled`, `maxSeverity`, `maxFraudScore`, `maxEstimate.amount`). Rule `when` and `then` are edited as JSON.

Not editable in the console: queues, notifications, integrations, AI settings, holidays, severity bands, security. Change those in the tenant file, or by `PUT /api/v1/config`.

Buttons: Validate (calls `/config/validate`), Validate and save (validates, then PUT with `If-Match` set to the loaded version), Revert edits. If someone else saved first, a "Configuration changed elsewhere" banner offers "Discard my edits and reload". Error links jump to the field. The console warns before you leave with unsaved edits.

## 8. Common mistakes

Each was reproduced with the validator and gives the error shown.

| Mistake | What you see |
| --- | --- |
| Rule or timer action names a queue that is not defined (`personal_claims` instead of `personal_auto_claims`) | `unknown_queue` at `/rules/n/then/0/queue` |
| `fastTrack.queue` names a missing queue | `unknown_queue` at `/fastTrack/queue` |
| Timer for a state no line of business serves | `unknown_state` and `state_not_served` |
| `showIf` reads `answers.x` that is not in the same question set | `unknown_question` |
| Misspelled operator (`equals`) | `oneOf` and `unknown_op` at `/rules/n/when` |
| `notifications.webhooks.includePii: true` | `const` and `pii_not_allowed` |
| Lowercase rule id (`rule1`), lowercase state (`mi`), color `blue`, prefix `kpt` | `pattern` errors |
| Routing action (`fast_track`, `route_queue`) in an `intake` rule | `action_stage_mismatch` |
| `provider: "cascade"` with an empty `cascade` list | `missing_cascade` |
| Extra key anywhere the schema is closed (for example a new top-level key) | `additionalProperties` |
| `require_question` for a question id that does not exist in any set | `unknown_question` |
| Timer citation without "illustrative" | warning only |
| Adding `seedVersion` to a tenant file to push a change | boot applies it, but later console saves fail `additionalProperties` (section 2) |
| Setting `slaHours`, `skills`, `region`, `webhooks.enabled` and expecting behaviour | accepted, but not read today (sections 4.5, 4.7, 4.8) |
| Creating a webhook for a host not in `allowedHosts` | 422 naming the host (section 4.8) |
| Raising `fastTrack.maxSeverity` but not the rule's own severity threshold | claims still not fast tracked (4.6) |
| `PUT` without `If-Match` | silently overwrites a newer version |

## 9. Quick reference

| Task | Endpoint | Role |
| --- | --- | --- |
| Read config | `GET /api/v1/config` | tenant_admin, carrier_admin, supervisor, auditor |
| Validate | `POST /api/v1/config/validate` | tenant_admin, carrier_admin |
| Save | `PUT /api/v1/config` with `If-Match` | tenant_admin, carrier_admin |
| UI-safe subset | `GET /api/v1/config/public` | claimant, agent, csr, adjuster, supervisor, tenant_admin, carrier_admin, integration, auditor |
| Webhooks | `/api/v1/integrations/webhooks` | tenant_admin, carrier_admin |
| Adapters | `/api/v1/integrations/adapters` | tenant_admin, carrier_admin, supervisor |

In the code the admin role is issued as `carrier_admin`; the contract calls it `tenant_admin`, and both are accepted. Get a dev token with `POST /api/v1/auth/token` (dev mode only), as described in `docs/setup.md`.

## 10. Contract vs code gaps (re-verified for Sprint 4)

Differences between the contract and the running code that a carrier would notice. Documentation only; the owners were told through the hubs.

Closed in Sprint 4, each re-read in code:
1. Restart overwrote console edits: closed. Seed-once loading with `seedVersion` (`src/core/tenants.mjs`, section 2). See open item 4.
2. AI safety settings unread: closed for `humanConfirmRequired`, `redactPiiBeforeModel`, `maxTokensPerClaim` (`src/ai/cascade.mjs`, section 4.7). `region` is still unread.
3. Webhook `allowedHosts` unread: closed. Enforced at create, update and delivery (section 4.8). `enabled` and `signingAlgorithm` are still unread.
4. `fieldMapProfile` unread: closed. It is the primary key and `profile` the alias (section 4.8).
5. Intake did not carry policy number or insured vehicle into the claim: closed. `enrichClaimCreate` (`src/modules/intake/mapping.js`) maps the policy number (an answer mapped to `policyNumber`, else the policy number the session was started with) and the insured vehicle from the policy snapshot (by picked unit id or VIN; a single-vehicle policy matches itself). Both tenants have an optional `insured_vehicle` question. Property lines get the matched insured location.
6. Intake submit idempotency: a client `Idempotency-Key` is now namespaced `intake:<sessionId>:<key>` (`src/modules/intake/security.js`).
7. `POST /claims` silently dropped an `answers` property: closed. Unknown properties are now a 400.

Still open:
1. AI task `next_question` appears in the schema comment and both tenants but is not a runtime task.
2. AI `region`, webhook `enabled` and `signingAlgorithm` are not read by code.
3. Queue `skills`, `slaHours` and `maxSeverity` are not read by routing.
4. `seedVersion` is used by the loader but missing from `TenantConfig.schema.json`; the validator rejects it, so a console save fails on a tenant whose stored copy carries it. Contract change requested.
5. `maxTokensPerClaim` is best-effort under concurrent calls on one claim (section 4.7).
6. Webhook signing has no timestamp header (SEC2-020), so receivers cannot reject replays from the header alone.
