# Bid Manager MVP — architecture and working contract

Read `docs/spec.md` (the binding spec, Greek) and `docs/blueprint.md` (process the app implements) first.
This file fixes the decisions the spec leaves open, so that several developers/agents can work in parallel.
If something here contradicts the spec, the spec wins — flag it in your report.

## Stack

- Monorepo, npm workspaces: `server/` (API + jobs) and `web/` (SPA). Node 22, TypeScript strict, ESM.
- Server: Express 5, `pg` (no ORM), zod for input validation, vitest + supertest for tests, tsx for dev.
- Web: React + Vite + TypeScript, react-router, @tanstack/react-query, i18next. Plain CSS with design tokens
  (`web/src/styles/tokens.css`) and the shared UI kit in `web/src/ui/`. No CSS framework.
- PostgreSQL 16. Dev DB: `postgres://bidmanager:bidmanager@127.0.0.1:5432/bidmanager_dev` (role has CREATEDB).
- Same stack family as TenderPro (React/Vite + Express).

## Layout

```
server/
  migrations/NNN_name.sql        plain SQL, applied in order by src/db/migrate.ts
  src/
    app.ts                       createApp(): express app (no listen) — used by tests
    index.ts                     listen + start jobs
    config.ts                    env parsing (zod)
    db/                          pool, migrate, scoped data layer — the ONLY place that touches pg
    core/                        auth, session, csrf, permissions, audit, events, errors, http helpers
    domain/                      pure/shared business functions (calendar, coverage, validity…)
    modules/<name>/              routes.ts (+ service.ts, *.test.ts) — one folder per feature
    jobs/                        scheduled jobs
    test/                        harness.ts (factories, login helpers), globalSetup.ts
web/
  src/
    api/                         client.ts (fetch wrapper, CSRF), types.ts
    ui/                          shared components
    i18n/el/<namespace>.json     Greek strings, one file per feature namespace
    features/<name>/             pages and components per feature
    app/                         router, layout, auth guard
```

## Data conventions

- Every table: `id uuid pk default gen_random_uuid()`, `org_id uuid not null references organization`,
  `created_at`, `updated_at` (timestamptz), `created_by uuid null`. Unique keys include `org_id`.
- Table names singular snake_case as in the spec (`"user"` is quoted). Enum-like columns are `text` with CHECK
  constraints and **English snake_case values**; Greek labels live only in i18n.
- Timestamps are `timestamptz` (UTC). Pure dates (`due_date`, `holiday.date`, `issued_at`, `expires_at`,
  `guarantee_valid_until`, watch dates) are `date`. In TS, dates travel as `'YYYY-MM-DD'` strings — never JS `Date`
  for pure dates (configure pg type parser 1082 to return the string). UI formats as dd/mm/yyyy, Europe/Athens.
- `T` = Athens-local date of `tender.submission_deadline_at`; `T0` = Athens-local date of `t0_published_at`.

### Enum values

| Column | Values |
| --- | --- |
| user.org_role | admin, bid_manager, member, approver, viewer |
| tender.status | evaluation, in_progress, submitted, no_go, cancelled |
| holiday.source | national, movable, manual |
| template.status | draft, published |
| template_item.kind | role, gate, milestone, task, handoff, checklist_item, watch_item, gate_criterion |
| template_item.offset_unit / watch_item.lead_unit | working, calendar |
| template_item.condition | always, demo, partners |
| milestone.kind | gate, milestone, handoff |
| gate.decision | pending, approved, approved_with_exception, rejected, go, no_go |
| gate_criterion.type | manual, auto |
| gate_criterion.auto_rule | exclusion_evidence_100, register_no_open, handoffs_received, guarantee_arrived, docs_valid_on_T |
| requirement.type | exclusion, scored, formal |
| requirement.folder / file.folder | participation, technical, financial (file.folder also: tender_docs, clarifications, other) |
| requirement.status | open, in_progress, covered, verified, deviation |
| task.status | open, in_progress, done, na, cancelled |
| task.section | task, checklist, handoff |
| risk.status | open, mitigating, occurred, closed |
| change_entry.source | adam, esidis, email, other |
| change_entry.kind | clarification, amendment, extension |
| company_document.type | iso, gemi, tax, insurance, cv, reference_project, other |
| file.confidentiality | normal, financial |

### Tables beyond the spec's list (all with org_id)

- `session` (id = opaque token hash, user_id, totp_verified, csrf_token, last_seen_at, expires_at)
- `invitation` (email, org_role, token_hash, expires_at, accepted_at)
- `tender_role` (tender_id, key, name, payload jsonb) — the per-tender snapshot of template roles;
  `payload.folder` ∈ participation/technical/financial, `payload.financial: true` marks the financial-offer role.
- `tender_document` (tender_id, company_document_id) and `change_entry_requirement` (change_entry_id, requirement_id)
- `job_run` (job, run_date, status, started_at, finished_at, detail jsonb; unique (org_id, job, run_date))
- `email_log` (user_id, kind, dedupe_key, subject, body, sent_at; unique (org_id, dedupe_key))
- Extra columns: `tender.guarantee_margin_days int default 30`, `tender.template_snapshot jsonb`,
  `tender.closed_at`; `milestone.needs_review bool`, `milestone.sort int`; `gate_criterion.sort`, `.key`;
  `gate.requested_at` (approval requested); `watch_item.needed_at date`, `watch_item.needed_milestone_key text`,
  `watch_item.checks text`; `requirement.weight text`; `file.tender_id null`, `file.deleted_at`, `file.enc jsonb`;
  `"user".password_hash`, `"user".totp_enabled_at`, `"user".last_login_at`; `task.milestone_id null`, `task.sort`,
  `task.done_at`; `organization.retention_days`.
- `audit_log` is append-only: a trigger rejects UPDATE/DELETE.

Offsets are **signed**: `anchor='T', offset_value=-8` = T−8; `anchor='T0', offset_value=3` = T0+3;
`anchor='G0', offset_value=2` = G0+2.

## The scoped data layer (tenant-ready rule — non-negotiable)

`server/src/db/scoped.ts` exports `scopedDb(orgId, userId)` returning `ScopedDb`:

```ts
list<T>(table, where?: Where, opts?: { orderBy?: string; limit?: number; offset?: number }): Promise<T[]>
get<T>(table, id): Promise<T | null>
findOne<T>(table, where): Promise<T | null>
count(table, where?): Promise<number>
insert<T>(table, data): Promise<T>            // sets org_id, created_by
insertMany<T>(table, rows): Promise<T[]>
update<T>(table, id, patch): Promise<T | null> // sets updated_at
remove(table, id): Promise<boolean>
sql<T>(text, params?: Record<string, unknown>): Promise<T[]>  // named params `:name`; text MUST contain `:org_id`
                                                              // (bound automatically) or it throws
tx<R>(fn: (db: ScopedDb) => Promise<R>): Promise<R>
```

- `Where` is an object of column → value (`null` → IS NULL, arrays → `= ANY`). Table/column names are validated
  against an allowlist read from the schema.
- `insert/update/remove` write `audit_log` rows automatically (entity, entity_id, action, before, after), except for
  `audit_log`, `session`, `job_run`, `email_log`. `password_hash`, `totp_secret`, `token_hash` are redacted.
- Nothing outside `server/src/db/` and `server/src/core/auth*` may import the pg pool. A test enforces this by grep.
- `org_id` comes from the session only. Never read it from body, query or URL.
- Every request handler gets `req.ctx = { orgId, user, db }` from the auth middleware.

## HTTP conventions

- All API under `/api`. JSON. Errors: `{ error: { code, message, details? } }` with proper status
  (400 validation, 401, 403, 404, 409, 422 business rule). Throw `HttpError` from `core/errors.ts`.
- Lists return `{ items: [...] }`. Resource of another org or missing → 404.
- Mutating requests need header `X-CSRF-Token` (value from `GET /api/auth/me`).
- Auth endpoints: `POST /api/auth/login`, `POST /api/auth/totp`, `GET /api/auth/totp/setup`,
  `POST /api/auth/totp/enable`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/accept-invite`.
- Auth contract (as implemented in `server/src/core/authRoutes.ts`; session cookie `bm_session`, httpOnly):
  - `POST /api/auth/login {email, password}` → 200 `{ stage: 'totp' | 'totp_setup', csrfToken }` (a *partial*
    session; nothing but the auth endpoints works with it). Wrong credentials → 401 `invalid_credentials`.
  - `POST /api/auth/totp {code}` → 200 `{ stage: 'ready', user, org, csrfToken }`; wrong code → 401 `invalid_code`.
  - `GET /api/auth/totp/setup` → `{ secret, otpauthUrl, qrDataUrl }` (only while the user has no TOTP);
    `POST /api/auth/totp/enable {code}` → same response as `/totp`.
  - `GET /api/auth/me` → 401 without a session; partial session → `{ stage: 'totp' | 'totp_setup', csrfToken }`;
    full session → `{ stage: 'ready', user: {id, email, name, org_role}, org: {id, name, timezone}, csrfToken }`.
  - `POST /api/auth/logout` → 204. `POST /api/auth/invite-info {token}` → `{ email, org_role, org_name }`;
    `POST /api/auth/accept-invite {token, name, password}` → 201 `{ ok: true, email }` (then log in; password ≥ 12 chars).
  - The session token is rotated when TOTP succeeds, so always use the `csrfToken` of the latest response.
    `X-CSRF-Token` is NOT required on login, totp, totp/enable, invite-info, accept-invite; it is on everything else.
- Tender-scoped module routers (`/api/tenders/:tenderId/<x>`) are mounted behind a guard that already enforces
  `requireTenderAccess` (read for GET/HEAD, write otherwise) and sets `req.tender`.
- Permissions (in `core/permissions.ts`):
  - `requireRole(...roles)`; `requireTenderAccess(ctx, tenderId, 'read' | 'write')` — admin and bid_manager reach
    every tender of the org; member/approver/viewer only tenders where they have a `tender_member` row; viewer is
    read-only everywhere.
  - `canSeeFinancial(ctx, tenderId)` (R18): admin, bid_manager, approvers who are members of the tender, and members
    whose `tender_role.payload.financial` is true. Viewer never.
- Feature routes live under `/api/tenders/:tenderId/<feature>` or `/api/<feature>` for org-level resources.

## Events

`core/events.ts`: in-process typed bus. `emit(ctx, name, payload)` / `on(name, handler)`. Handlers run after the
response path and must never throw into the emitter. Events:
`gate.approval_requested {tenderId, gateId, approverUserId}`, `gate.decided {tenderId, gateId, decision}`,
`tender.extended {tenderId, oldT, newT}`, `tender.created {tenderId}`, `handoff.delivered {tenderId, taskId}`.

## Domain helpers (`server/src/domain/`, pure where possible)

- `calendar.ts`: `orthodoxEaster(year)`, `greekHolidays(year)`, `isWorkingDay(date, holidays:Set<string>)`,
  `addWorkingDays(date, n, holidays)` (R4, signed n), `addCalendarDays(date, n, holidays)` (R5: if the result is not a
  working day go to the previous working day), `workingDaysBetween(a, b, holidays)`, `applyOffset(...)`.
- `time.ts`: `athensDate(tsUtc)`, formatting helpers (R3).
- `register.ts`: `coverageByType(rows)` (R17).
- `validity.ts`: `expiredOnT(docs, T)` (R15), `guaranteeWarning(tender)` (R16).
- `loadHolidays(db)` reads the org's `holiday` rows into a Set.

## Tests

- `npm test -w server` runs vitest. `globalSetup` creates a **fresh uniquely-named database per run**, migrates it and
  drops it at the end, so parallel runs never collide. Test files run serially inside one run.
- `server/src/test/harness.ts`: `createOrg()`, `createUser(org, role)`, `createTender(org, overrides)`,
  `addMember(tender, user, roleKey)`, `as(user)` → supertest agent already authenticated (session row + CSRF header),
  `seedHolidays(org, years)`.
- Every R-rule gets unit tests; every module gets a cross-org test (a second org's data never leaks).

## Web conventions

- All text through i18next (`t('tenders:title')`), namespace per feature, Greek only.
- Data fetching through react-query hooks colocated in the feature folder, using `api/client.ts`.
- Use the UI kit (`web/src/ui`): Button, Field/Input/Select/Textarea/Checkbox, Table, Modal, Badge, Banner, Tabs,
  PageHeader, EmptyState, Spinner, DateText, ConfirmDialog, toast. Extend the kit rather than restyling ad hoc.
- Responsive down to 360 px. Status colours: red = blocking, orange = warning, green = ok.

## Parallel-work rules

- Stay inside the files/folders you own. Shared files (router, nav, i18n index, app.ts module mounting) are already
  wired to stubs — fill your stub, do not re-wire.
- Do not run `npm install` or edit `package.json` — everything needed is installed. If something is truly missing,
  say so in your report instead.
- Do not commit; do not start long-lived servers on fixed ports without stopping them.
- `tsc`/build may show errors from other people's in-progress files — fix only your own.
- New migrations, if unavoidable, use your assigned number range.
