# Bid Manager — server

Express 5 + PostgreSQL API and scheduled jobs. The binding contract is `../ARCHITECTURE.md`; the schema is
`migrations/001_init.sql`.

## Run

```bash
cp server/.env.example server/.env        # then set FILE_ENCRYPTION_KEY (openssl rand -hex 32) — required
npm run migrate -w server                 # apply migrations/NNN_*.sql in order (idempotent)
npm run seed -w server                    # one organization, an admin, holidays for last year … +2 (idempotent)
npm run dev:server                        # http://localhost:3001  (GET /api/health)
npm test -w server                        # vitest; creates and drops its own database
npm run typecheck -w server
```

`seed` reads `SEED_ADMIN_EMAIL` (default `admin@example.com`) and `SEED_ADMIN_PASSWORD` (≥ 12 characters; when
empty a random password is generated and printed once). The admin enrols TOTP at first login. Further users are
created only by invitation (`POST /api/admin/invitations`).

Outside the test suite the server needs its own `FILE_ENCRYPTION_KEY` (`openssl rand -hex 32`; it also encrypts
TOTP secrets, so keep it stable and backed up) — there is no built-in development key. Production
(`NODE_ENV=production`) additionally needs an https `APP_URL`, `SMTP_HOST`, and an explicit `TRUST_PROXY` (1 behind
one reverse proxy); it refuses to start otherwise. `npm run build -w server` compiles to `dist/` (tests excluded);
`npm run start`, `migrate:prod`, `seed:prod` run from there. When `../web/dist` exists the same process serves the
web app (hashed assets immutable, `index.html` no-cache, history fallback, never under `/api`). Deployment: the
root `README.md`.

Added during integration: `POST /api/admin/users/:id/reset-password` (admin; single-use 24 h link, consumed by
`POST /api/auth/reset-info` / `reset-password`), `core/errorTracking.ts` (`reportError`, `setErrorReporter`),
`listApiRoutes()` in `app.ts` (every route, read from the routers — the acceptance sweep and the guard tests iterate
it), `ensureHolidayYears()` behind `loadHolidays()`, `catchUpDailyJobs()` in the job runner, and the two-role
database option of `migrate` (`MIGRATION_DATABASE_URL`, `APP_DATABASE_ROLE`).

## Layout

```
migrations/            plain SQL
src/config.ts          environment (zod)
src/db/                pool, migrate, seed, scoped.ts (the scoped data layer), admin.ts (cross-org bootstrap helpers)
src/core/              auth, sessions, CSRF, permissions, errors, events, mailer, crypto
src/domain/            calendar, time, register, validity, holidays (pure, unit-tested)
src/modules/<name>/    routes.ts (+ service.ts, jobs.ts, *.test.ts) — one folder per feature
src/jobs/index.ts      registerJob / runJob / startJobs
src/test/              globalSetup.ts, harness.ts
```

## Data access

Handlers use `req.ctx.db` (a `ScopedDb` bound to the session's organization) and nothing else:

```ts
const { db, user, orgId } = req.ctx;
await db.list('task', { tender_id: id, status: ['open', 'in_progress'] }, { orderBy: 'due_date nulls last, sort' });
await db.get('tender', id);                         // null when missing or in another org
await db.insert('risk', { tender_id: id, title });  // org_id, created_by and the audit row are automatic
await db.update('risk', riskId, { status: 'closed' });
await db.sql('SELECT … FROM task WHERE org_id = :org_id AND due_date < :today', { today });  // must contain :org_id
await db.tx(async (tx) => { … });                   // use tx inside; nested tx = savepoint
```

Never import `pg` or `src/db/pool.ts` outside `src/db/` — a test fails the build if you do.

## Writing tests

`src/test/harness.ts` (the database is created per run by `globalSetup.ts`; tests create their own org and never
clean up):

| Helper | |
| --- | --- |
| `createOrg(overrides?)` | a new organization |
| `createUser(org, role = 'member', overrides?)` | a user; `{ password }` adds a real credential and `user.totpSecret` |
| `createTender(org, overrides?)` | a tender (`in_progress`, T = today + 30 days); any column can be overridden |
| `addRole(tender, key, payload?, name?)` | a `tender_role` (`{ financial: true }` marks the financial role) |
| `addMember(tender, user, roleKey?)` | a `tender_member` row |
| `seedHolidays(org, years)` | Greek holidays for a year or list of years |
| `dbFor(org, user?)` | the scoped data layer, for arranging/asserting directly |
| `as(user)` | authenticated supertest agent (session cookie + `X-CSRF-Token` sent automatically) |
| `anon()` | unauthenticated agent that keeps cookies |
| `getApp()`, `missingId()` | the express app; a uuid that matches nothing |

```ts
import { describe, expect, it } from 'vitest';
import { addMember, as, createOrg, createTender, createUser, dbFor } from '../../test/harness.js';

describe('risks', () => {
  it('a member adds a risk; another org never sees it', async () => {
    const org = await createOrg();
    const member = await createUser(org, 'member');
    const tender = await createTender(org, { submission_deadline_at: '2027-05-07T12:00:00Z' });
    await addMember(tender, member, 'B');

    const res = await as(member).post(`/api/tenders/${tender.id}/risks`).send({ title: 'Εγγυητική αργεί' });
    expect(res.status).toBe(201);
    expect(await dbFor(org).count('risk', { tender_id: tender.id })).toBe(1);

    const foreign = await as(await createUser(await createOrg(), 'admin'));
    expect((await foreign.get(`/api/tenders/${tender.id}/risks`)).status).toBe(404);
  });
});
```

`as(user)` can be chained directly (`await as(u).get(…)`, a new session each time) or awaited once and reused
(`const api = await as(u)`). Test files run serially; everything in a file shares one app and one pool.

## Adding a module

Modules are mounted from the two tables at the top of `src/app.ts` (`TENDER_SCOPED`, `ORG_LEVEL`); a new router
must be added there — `app.test.ts` fails if a route is mounted outside them.

- Org-level routers (`/api/<name>`) sit behind `requireAuth`: `req.ctx = { orgId, user, db }` is always set and CSRF
  is already checked for mutating requests.
- Tender-scoped routers (`/api/tenders/:tenderId/<name>`, `mergeParams`) additionally sit behind `tenderGuard`:
  read access is enforced for GET/HEAD, write access for everything else, and the tender row is on `req.tender`.
  Financial files still need `canSeeFinancial(req.ctx, tenderId)` (R18).
- Validate input with zod (`schema.parse(req.body)`; a `ZodError` becomes a 400), throw `HttpError`/`notFound()`/
  `forbidden()`/`unprocessable()` from `core/errors.ts`. Express 5 forwards rejected promises, so no try/catch.
- Lists return `{ items: [...] }`. Use `requireRole('admin', 'bid_manager')` for role-gated routes.
- Scheduled work: `src/modules/<name>/jobs.ts` calling `registerJob(...)` (picked up automatically).
- Events: `emit(req.ctx, 'tender.created', { tenderId })`; subscribe with `on(...)` at the top level of `routes.ts`.
- Every module needs a cross-org test like the one above.
