# FNOL Design System v2

Owner: Claimant & Agent Experience (S6-EXP-01) · Status: adopted for Sprint 6 · Source: `src/web/shared/`

This is the visual language for every surface the platform ships: the claimant intake app, the CSR desk, the adjuster workbench and the tenant admin console. It exists so a carrier evaluating the product sees one calm, credible, modern insurance product, wearing *their* brand, instead of four developer pages.

Reference implementation: open `/shared/kitchen-sink.html` on a running platform (`npm start`). Reviewer screenshots: `docs/design/screens/kitchen-sink-{light,dark}.png` (1440×900, full page) and `kitchen-sink-{light,dark}-mobile.png` (390×844 viewport), written by `tests/ui/design-system.test.mjs`. Before: `docs/design/before/`.

---

## 1. Principles

1. **Calm over loud.** A claim is a bad day for someone. Neutral surfaces, one accent colour, colour reserved for meaning (status, severity, errors). No gradients, no decorative illustration.
2. **Hierarchy you can scan in two seconds.** Every page has one H1 with a one-line subtitle, a primary action at top right, and content in cards. Numbers are right-aligned with tabular figures.
3. **Dense where work happens, generous where people are stressed.** Adjuster and admin tables use the compact density; the claimant app keeps 44 px touch targets and a 16 px base.
4. **Borders before shadows.** Hairline dividers separate things; shadows are reserved for things that float (menus, toasts, hover).
5. **The carrier's brand, our product.** The tenant's primary colour drives the accent (buttons, selection, current nav, avatar). Everything else stays product neutral so the product looks the same quality for every tenant.
6. **Accessible by construction.** WCAG 2.2 AA: 4.5:1 text, 3:1 control borders and focus, visible focus on every interactive element, motion off under `prefers-reduced-motion`, en and es from day one.

## 2. Colour

All colours are CSS custom properties in `tokens.css`. Components use **semantic aliases only**, never raw hex.

### 2.1 Neutrals (cool slate)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--fx-canvas` | `#f5f6f8` | `#0c0f13` | App background behind cards |
| `--fx-bg` | `#ffffff` | `#13171d` | Raised surface: cards, inputs, menus, toasts |
| `--fx-surface` | `#f5f6f8` | `#191e25` | Subtle fill: table header, card footer, drop zone |
| `--fx-surface-2` | `#eceef2` | `#232a33` | Hover/pressed fill, skeleton bones |
| `--fx-divider` | `#e1e4e9` | `#262d37` | Hairlines between rows and card sections (decorative) |
| `--fx-border` | `#7f8897` | `#6b7585` | Edge of interactive controls (≥ 3:1) |
| `--fx-text` | `#161a21` | `#ebeef2` | Primary text |
| `--fx-text-muted` | `#545d6b` | `#a7b0bd` | Secondary text, labels, metadata |
| `--fx-text-subtle` | `#5f6876` | `#8a94a2` | Placeholders, tertiary text (still ≥ 4.5:1) |

The raw ramp `--fx-gray-0 … --fx-gray-900` exists for one-off illustrations only.

### 2.2 Brand (from tenant branding)

`theme.js applyBranding(publicConfig)` writes the tenant's `branding.primaryColor` to `--fx-brand` and picks `--fx-on-brand` (white or near-black, whichever contrasts more). Default product brand is `#2a55c4`.

Derived, so they follow the tenant automatically (`color-mix`):

| Token | Use |
|---|---|
| `--fx-brand` / `--fx-on-brand` | Primary button, completed stepper dot, brand mark, user chat bubble |
| `--fx-brand-hover` | Primary button hover (darker in light, lighter in dark) |
| `--fx-brand-subtle` | Selected chip, KPI icon tile, avatar, focus halo |
| `--fx-brand-muted` | Avatar border, spacing swatches |
| `--fx-brand-text` | Links and brand-coloured text; lightened in dark mode so dark tenant colours stay legible |

`--fx-accent` (tenant `accentColor`) is reserved for marketing moments (claimant welcome) and is **not** used for UI state. One accent colour per screen.

### 2.3 Semantic

Each tone has a foreground (text/icon on any surface, ≥ 4.5:1), a subtle background and a border. Badge text on its subtle background is also ≥ 4.5:1.

| Tone | Light fg | Dark fg | Meaning |
|---|---|---|---|
| `success` | `#0f6e45` | `#5cc995` | Done, covered, fast-tracked, minor severity, good trend |
| `warning` | `#8a5000` | `#eab05a` | Needs attention: pending info, in review, major severity |
| `danger` | `#b4232b` | `#ff8b91` | Errors, failed, severe, destructive actions, bad trend |
| `info` | `#1f5bb8` | `#82b1ff` | Neutral progress: reported, validating, moderate severity |
| `neutral` | `#4a5361` | `#b3bcc8` | Closed, withdrawn, cancelled |
| `brand` | tenant | tenant | Owned by someone: assigned, triaged, in progress |

Never rely on colour alone: badges always carry a label; trend deltas carry an arrow icon and a visually hidden "up/down".

### 2.4 Dark mode

Dark applies from `prefers-color-scheme: dark` unless `<html data-theme="light">`, or explicitly with `data-theme="dark"` (`theme.js setScheme`). The two dark blocks in `tokens.css` hold identical values (unit-tested). Dark surfaces step *up* in lightness as they rise (canvas → bg → surface → surface-2); shadows get darker rather than lighter.

### 2.5 Demo band

`--fx-demo-bg/fg/muted/border/accent`: a near-black band that sits above the product top bar in demo deployments. It is deliberately "not the product" so a buyer never mistakes the persona switcher for a carrier feature.

## 3. Typography

- **UI face** `--fx-font-ui`: Inter when installed locally, otherwise the platform system UI stack (`ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial`). No webfont is downloaded; the product makes no font requests.
- **Brand face** `--fx-font`: the tenant's `branding.fontFamily` if set, else the UI face. Used for the page H1, the brand mark and the tenant name only, so a serif tenant (Aurelia: Georgia) shows its personality without making data tables look dated.
- **Mono** `--fx-font-mono`: claim and policy numbers in dense contexts.

| Token | Size / line / weight | Use |
|---|---|---|
| `--fx-fs-3xl` | 30 / 1.1 / 600, −0.02em | KPI values |
| `--fx-fs-2xl` | 24 / 1.25 / 600, −0.015em | Page title (H1) |
| `--fx-fs-xl` | 20 / 1.25 / 600 | Section titles; H1 on mobile |
| `--fx-fs-lg` | 18 / 1.25 / 600 | H2 |
| `--fx-fs-base` | 16 / 1.5 / 400 | Body, claimant questions, card titles |
| `--fx-fs-md` | 14 / 1.4 / 400–600 | UI default: tables, buttons, inputs, nav |
| `--fx-fs-sm` | 13 / 1.4 | Hints, errors, subtitles, metadata |
| `--fx-fs-xs` | 12 / 1.3 / 600 | Badges, table headers (uppercase +0.04em), timestamps |

Weights: 400 body, 500 labels and nav, 600 titles and buttons, 700 avatar initials only. Numbers use `font-variant-numeric: tabular-nums` wherever they line up.

## 4. Spacing and layout

8 px grid with a 4 px half step: `--fx-space-1…9` = 4, 8, 12, 16, 24, 32, 40, 48, 64.

- Inside controls: 12–16 px horizontal. Between related fields: 16. Between cards: 24. Between page sections: 48–64.
- Page content max width `--fx-content-max` 1280 px, 32 px side padding (16 px below 1024 px).
- Grids: `.fx-stat-grid` (auto-fit KPI tiles, 2-up on phones), `.fx-grid-main` (2:1 work + context, stacks below 1024 px), `.fx-grid-2`, `.fx-stack`, `.fx-cluster`.
- Breakpoints: **768 px** (shell collapses, tables scroll horizontally, stepper shows the current label only), **1024 px** (two-column layouts stack).

## 5. Radius

`--fx-radius-sm` 6 (small buttons, table sort targets), `--fx-radius` 8 (controls, alerts), `--fx-radius-lg` 12 (cards, menus, toasts, drop zone), `--fx-radius-pill` (badges, chips, avatar).

## 6. Elevation

| Token | Use |
|---|---|
| none + `--fx-divider` border | Default for cards and tables |
| `--fx-shadow-xs` | Cards, buttons, inputs (barely there, gives edges in light mode) |
| `--fx-shadow-md` | Hovered interactive card, mobile nav sheet |
| `--fx-shadow-lg` | Menus, toasts: anything that floats over content |

Z order: sticky table header 1 → shell 30 → menus 40 → toasts 60.

## 7. Motion

`--fx-dur-fast` 120 ms (hover, colour), `--fx-dur` 180 ms (menus, toggles), `--fx-dur-slow` 280 ms (toast enter). Easing `--fx-ease` for state changes, `--fx-ease-out` for things entering. Motion confirms, never decorates: no bouncing, no parallax. Under `prefers-reduced-motion: reduce` every animation and transition is effectively instant.

## 8. Density

Default (comfortable): 40 px controls on fine pointers, 44 px on touch (`--fx-target`), 48 px table rows. `data-density="compact"` on any container: 32 px controls, 36 px rows; use for the adjuster inbox and admin tables. Never compact the claimant app.

## 9. Focus and accessibility

- `:focus-visible` draws a 2 px `--fx-focus` outline with 2 px offset on every interactive element; inputs also get a 3 px halo (`--fx-ring`) on focus. Never remove an outline without an equal replacement (menu items use an inset ring).
- Touch targets ≥ 24 px everywhere, 44 px in the claimant app.
- Components announce: toasts via `role=status/alert`, skeletons via `role=status` with a label, tables announce row count, stepper announces "Step n of m".
- The Playwright test tabs through the kitchen sink and fails if any focused element has no visible indicator.

## 10. Components: when to use what

All are vanilla custom elements in light DOM (no shadow root, so app CSS and tests reach inside), zero dependencies, registered by `import '/shared/components/index.js'`.

### Application shell: `<fx-app-shell>`
Use once per app, wrapping the whole page. Provides: sticky top bar with product name, tenant brand mark and name, primary nav, account menu (name, role, tenant, sign out), page header (H1, subtitle, actions) and the demo band.
- Attributes: `product`, `tenant-name`, `heading`, `subheading`, `user-name`, `user-role`, `nav-label`, `home-href`, `logo`, `no-signout`. Property `navItems = [{href,label,icon?,current?}]`.
- Slots (children with a `slot` attribute): `demo` (persona switcher, `<fx-demo-bar>` from S6-EXP-02), `nav` (links; mark the current one `aria-current="page"`), `actions` (page header buttons, primary last), `user-menu` (extra account menu items). Everything else is page content.
- Sets `--fx-demo-height` on itself and `:root`; `--fx-sticky-top` lets table headers stick under the bar. Emits `fx-signout`.
- Below 768 px the nav collapses behind a menu button (Escape closes), the account button shows the avatar only.
- Apply tenant branding with `applyBranding(publicConfig)` before or after mounting; the brand mark uses the tenant initials on `--fx-brand`.

### Buttons: `.fx-btn`
One **primary** per view region (the thing you want done). **Secondary** (`.secondary`) for alternatives. **Ghost** (`.ghost`) for low-emphasis toolbar actions. **Danger** (`.danger`) only for irreversible actions, and `.danger.secondary` in tables. Sizes `.small`, default, `.lg`; `.icon` for icon-only (always with `aria-label`); `.block` for full width on mobile forms. `aria-busy="true"` shows a spinner; `disabled` for unavailable. Labels are verbs ("Submit claim", not "OK").

### Status chip: `<fx-badge>`
For any enumerated state. `status` + `kind` (`claim`, `task`, `sync`, `coverage`, `risk`) or `severity`; label and tone come from the mapping in `badge.js` and `format.js` (en/es):

| Claim status | Label | Tone |
|---|---|---|
| reported / validating | Reported / Validating | info |
| triaged / assigned | Triaged / Assigned | brand |
| fast_tracked | Fast-tracked | success |
| in_review / pending_info | In review / Pending info | warning |
| closed / withdrawn | Closed / Withdrawn | neutral |

| Severity band | Label | Tone |
|---|---|---|
| minor (0–24) | Minor | success |
| moderate (25–49) | Moderate | info |
| major (50–74) | Major | warning |
| severe (75–100) | Severe | danger |

Free text: `<fx-badge tone="danger" variant="solid">SIU referral</fx-badge>`. Use solid only for the one thing on a screen that must not be missed. Never show raw tokens like `pending_info`.

### Card: `<fx-card>`
The unit of layout. `heading`, `subheading`, `level`, `padding="none|sm"`; children with `slot="actions"` go in the header, `slot="footer"` in a muted footer. Use `padding="none"` when the card holds a table. Don't nest cards.

### KPI tile: `<fx-stat>`
`label`, `value` (already formatted), `delta`, `good="up|down"` (which direction is good, e.g. `down` for time to acknowledge), `period`, `icon`, `hint`. Use 3–4 in a `.fx-stat-grid` at the top of overview pages only.

### Table: `<fx-table>`
For lists users scan and pick from. Columns `{key, label, render?, numeric?, align?, sortable?}`; `render` may return a Node (badges, two-line cells using `.fx-sub`). Sticky header, no zebra stripes, row hover, keyboard row selection (Enter, arrows), sortable headers with `aria-sort`. Right-align every number and date-ago column (`numeric: true`). Put tables in `fx-card padding="none"`. Plain HTML tables can use `class="fx-table"`.

### Form controls
`<fx-field>` (label, hint, inline error with `aria-describedby`), `.fx-input/.fx-select/.fx-textarea` for raw controls, `.fx-form-row` for side-by-side fields, `.fx-check-row` for checkboxes, `.fx-switch` for on/off settings. Optional fields say "(optional)"; required ones don't shout. Errors appear on blur and on submit, in `--fx-danger`, under the field, saying how to fix it.

### Choice chips: `<fx-chips>`
For 2–6 short options (loss type, yes/no). Single select is a radio group with roving focus. More than 6 options: use a select.

### Stepper: `<fx-stepper>`
For linear flows of 3–6 steps (claimant and CSR intake). Completed steps fill with brand, the current step has a ring. Don't use for navigation between unrelated pages.

### Timeline: `<fx-timeline>`
Claim activity and audit history, newest first. Events `{at, title, detail, actor, tone?}`; tone colours the marker using the same semantic map as badges. AI events put `provider/model · confidence` in `actor` (standards: never show AI output without them).

### Toast: `<fx-toast>`
Mount once per app. Short confirmations of something the user just did ("Claim assigned"), success/info auto-dismiss after 6 s, errors stay until dismissed. Never use a toast for something the user must act on: use an inline `.fx-alert` instead.

### Alert: `.fx-alert[data-tone]`
Inline banner with icon, bold title and one sentence: service unavailable, coverage pending, conflict on save.

### Empty state: `<fx-empty-state>`
Every list and table has one. `icon`, `heading` (what's true, positively phrased), `description` (what will make it change), and at most one secondary action.

### Skeleton: `<fx-skeleton>`
Shown while the first load is in flight (> 300 ms). `variant="text|card|table|block|circle"`. Match the shape of what will appear; never show a spinner and a skeleton together.

### Icons: `icons.js`
66 original inline SVG icons on a 24 px grid, 1.75 px round stroke, `currentColor`. `icon(name, {size, label})` returns markup; `createIcon(name, opts)` a node. Decorative by default (`aria-hidden`); pass `label` when the icon is the only content. 16 px in dense UI, 20 px default, 24 px in empty states. No icon fonts, no CDN.

## 11. Content formatting (`format.js`)

Never print ISO timestamps or enum tokens. Use:

| Function | Example (en) | Example (es) |
|---|---|---|
| `formatDateTime` | Oct 19, 2026, 12:24 PM | 19 oct 2026, 12:24 |
| `formatRelative` | 3 min ago · in 2 h · just now | hace 3 min · en 2 h |
| `formatEnum` | Pending info · Commercial auto | Información pendiente · Auto comercial |
| `formatMoney` | $12,480 · $640.00 | 12.480 US$ |
| `formatPolicyNumber` | PA-MI-2241587 (mask: PA-MI-•••1587) | same |
| `formatClaimNumber` | KPT-2026-000015 | same |
| `formatDuration` | 2 h 5 min | 2 h 5 min |

Relative time for anything under a week (with the full date in a `title`/tooltip), absolute dates beyond. Whole-dollar amounts ≥ $1,000 drop cents.

## 12. Voice

Plain, specific, kind. Sentence case everywhere ("Recent claims", not "Recent Claims"). Say what happened and what to do next. Don't blame the user. Synthetic data only in demos: fictional carriers are always marked "(fictional)".

## 13. Adoption (Wave B)

Existing apps keep working unchanged: every v1 class (`.fx-btn`, `.secondary`, `.small`, `.skip`, `.muted`, `.fx-visually-hidden`) and element API is preserved, and base element styles use `:where()` so app CSS still wins. To adopt: wrap the page in `<fx-app-shell>`, remove the app's own header bar, move page actions to `slot="actions"`, replace raw status text with `<fx-badge>`, wrap sections in `<fx-card>`, and format every date, enum and amount with `format.js`.


## 14. Design QA decisions (S6-EXP-07)

- **Fonts.** The tenant brand font (`--fx-font`, e.g. Georgia for Aurelia Mutual) applies only to the shell brand mark and the tenant name. Page titles (`.fx-shell-title`), the demo bar and every control use the product UI font `--fx-font-ui`. Selects in the demo bar never fall back to a serif.
- **Identity shown once.** When the demo bar sits inside `fx-app-shell`, the shell account menu shows the persona (name, role, tenant) and the demo bar hides its name/avatar block (`fx-app-shell[data-has-demo] fx-demo-bar .fxd-who`). A standalone demo bar, outside a shell, still shows it. The "Not signed in" state stays visible.
- **AI summary card.** Dates in the narrative go through `format.js`; the `Facts used:` trailer is moved into a collapsed "Details" disclosure. Provider, model, confidence and explanation stay visible.
- **Inbox timers.** The inbox timer column and the Due today / Overdue tiles use the next open timer from `claims.listTimers`, the same source as the claim view.
