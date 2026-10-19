# UX flows and shared UI kit (S1-EXP-01)

Four apps share one kit in `src/web/shared/`: claimant (`/`), CSR (`/csr`), adjuster (`/adjuster`), admin (`/admin`). All data is synthetic.

## 1. Claimant: guided and conversational intake

Claimants choose a mode up front and may switch at any time; both write the same draft claim so no answers are lost.

```mermaid
flowchart TD
  A[Landing: branding from GET /config/public, language en/es] --> B{Mode}
  B -->|Guided| C[fx-stepper: Policy and contact]
  B -->|Chat| H[fx-chat: assistant asks one question at a time]
  C --> D[Loss type and date via fx-chips]
  D --> E[What happened: free text]
  E --> F[Photos and documents via fx-upload]
  F --> G[Review and edit all answers]
  H -->|AI extracts fields, shows provider, model, confidence, explanation| G
  G <-->|switch mode, draft kept| B
  G --> I{Validation}
  I -->|errors| C
  I -->|ok| J[POST claim, then evidence uploads]
  J --> K[Confirmation: claim number, next steps, fx-timeline]
  J -->|service_unavailable| L[fx-toast, draft saved locally, Retry]
  L --> J
```

Notes: injuries or safety keywords in chat trigger an emergency banner (call 911) before anything else. Fraud warning text from branding is shown on the review step. Every AI-suggested value is editable and labelled as a suggestion.

## 2. CSR-assisted intake

```mermaid
flowchart TD
  A[CSR signs in] --> B[Caller lookup: policy number or name]
  B --> C[fx-table of matches, Enter selects row]
  C --> D[Split view: script prompts left, form right]
  D --> E[Guided questions from question sets for loss type]
  E --> F[Live AI suggestions panel with confidence and explanation]
  F --> G{CSR accepts or edits each suggestion}
  G --> H[Attach evidence on behalf of caller]
  H --> I[Submit claim]
  I --> J[Claim number to read to caller, timeline shown]
  I -->|conflict or validation| K[Inline field errors, focus first error]
  K --> E
```

Keyboard first: full flow without a mouse, shortcuts documented on screen, no timeouts that discard data.

## 3. Adjuster first view

```mermaid
flowchart TD
  A[Adjuster signs in] --> B[Queue: fx-table sorted by priority and SLA]
  B --> C[Open claim]
  C --> D[Summary: parties, loss, coverage flags]
  D --> E[AI triage card: severity, fraud signals, provider, model, confidence, explanation]
  D --> F[fx-timeline of events and audit]
  D --> G[Evidence gallery with extracted fields]
  E --> H{Decision}
  H -->|Accept triage| I[Set status or assign]
  H -->|Override| J[Reason required, audited]
  I --> K[fx-toast confirmation]
  J --> K
  C -->|version_conflict| L[Reload prompt, show who changed it]
```

## 4. Carrier admin configuration

```mermaid
flowchart TD
  A[Tenant admin signs in] --> B[Config overview: version, last change]
  B --> C[Edit section: branding, LOBs, question sets, rules, queues, timers, AI]
  C --> D[Validate: POST config validate, report with paths]
  D -->|errors| C
  D -->|ok| E[Preview: branding applied live via theme.applyBranding]
  E --> F[Save with current version PUT]
  F -->|version_conflict| G[Show diff, reload latest, reapply]
  F -->|ok| H[Audit entry, fx-toast, new version in fx-timeline]
```

Colors must be six digit hex; the kit rejects anything else and the admin form shows the error.

## Accessibility targets (WCAG 2.2 AA)

- Contrast: text 4.5:1, large text and UI boundaries 3:1; verified for tokens by `tests/unit/web/shared/theme.test.js`. Brand text color is chosen automatically (`readableOn`).
- Target size: controls at least 24 by 24 CSS px (2.5.8), kit default 44px.
- Keyboard: all functions operable by keyboard (2.1.1), no traps; visible focus ring 3px (2.4.7, 2.4.11 focus not obscured). Chips use roving tabindex and arrow keys; table rows are focusable, header sort buttons carry `aria-sort`.
- Labels and errors: every field has a programmatic label, `aria-describedby` for hint and error, `role=alert` errors, `aria-invalid` (3.3.1, 3.3.3). Required state is text, not color alone.
- Status messages: chat log, toasts, stepper and table counts use `aria-live` or `role=status/alert` (4.1.3).
- Stepper uses an ordered list with `aria-current="step"` and text for state.
- Consistent help and no redundant entry (3.2.6, 3.3.7): draft kept across mode switches; entered data is never asked twice.
- Authentication (3.3.8): no cognitive tests; paste allowed in all fields.
- Reflow at 320px and 200% zoom; respects `prefers-reduced-motion` and `prefers-color-scheme`.
- Image previews have alt text; decorative icons are `aria-hidden`.

## Multilingual (en/es)

- `i18n.js`: `t(key, params)`, `setLocale`, `getLocale`, `registerStrings(locale, table)`. Missing keys fall back to `en`, then to the key. `<html lang>` is updated on locale change.
- Kit owns `common.*` and `kit.*`; apps register `claimant.*`, `csr.*`, `adjuster.*`, `admin.*`. A parity test enforces identical key sets and placeholders for the kit; apps should add the same test for their tables.
- Default locale from the user choice, then tenant `locales` in public config, then `en`. Tenant text (`I18nText`) resolves with `resolveText`.
- Dates use `Intl.DateTimeFormat(locale)`; phone and address formats are not locale-assumed. Strings avoid concatenation so Spanish word order works; allow about 30 percent text growth.
- Spanish copy uses formal "usted" and plain language, to be reviewed by a native speaker before production.

## Kit interface

`api.js` (`createApiClient`, `ApiError`; network, 5xx and non-envelope 404 become `service_unavailable`), `i18n.js`, `theme.js` (`applyBranding`, `setScheme`), `devlogin.js` (`devLogin`, dev mode only), `tokens.css`, `components.css`, and `components/index.js` registering `fx-field`, `fx-chips`, `fx-stepper`, `fx-upload`, `fx-chat`, `fx-timeline`, `fx-toast`, `fx-table`. Components emit `fx-change` or `fx-submit` (table rows emit `fx-select`).

Contract note: `POST /auth/token` is documented with `userId`, `displayName`, and a `201` response of `{token, expiresAt, principal}`, but core currently reads `sub` and `name` and returns `200 {token, tokenType, claims}`. `devLogin` sends both field names and returns the body untouched.
