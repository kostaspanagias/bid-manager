# Bid Manager — web

React 19 + Vite + TypeScript SPA. Greek-only UI, plain CSS with design tokens, no UI/CSS/icon libraries.
Read `../ARCHITECTURE.md` first; this file covers only what a feature engineer needs.

## Run

```bash
npm run dev -w web         # Vite on :5173, proxies /api → http://127.0.0.1:3001 (start the server separately)
npm run typecheck -w web   # tsc --noEmit (strict)
npm run build -w web       # typecheck + production build to web/dist
node web/scripts/screenshots.mjs [filter]   # visual smoke test, no server needed (mocks /api, writes scripts/screenshots/)
```

## Layout

```
src/
  main.tsx, app/        App (providers), router.tsx (ALL routes), AppLayout (shell), nav.ts, guards, ErrorBoundary
  styles/               tokens.css (design tokens — only source of colours/sizes), base.css (reset + .u-* utilities)
  ui/                   the UI kit — import from '@/ui'
  api/                  client.ts (fetch wrapper, CSRF, ApiError), types.ts (entities + enums)
  lib/                  dates.ts (Athens formatting, working days, T−n), enums.ts (Greek labels + tones), cx.ts
  i18n/                 index.ts + el/<namespace>.json (one per feature)
  features/<name>/      pages, components, hooks and <name>Api.ts of one feature
  features/shared/      useUsers, UserSelect, StatusBadge, useHolidaySet / useWorkingDaysTo
```

`@/` is an alias for `src/`.

## Filling a stub

Every route already renders a stub page in your feature folder (`PageHeader` + `EmptyState`). **Replace the body of
that component; do not touch `app/router.tsx`, `app/nav.ts`, `i18n/index.ts` or `ui/`** (if the kit lacks something,
add a component to `ui/` rather than restyling locally, and say so in your report).

1. **API + hooks** — keep endpoint shapes in `features/<name>/<name>Api.ts`, hooks next to it:

   ```ts
   // features/risks/risksApi.ts
   import { api, type ListResponse } from '@/api/client';
   import type { ID, Risk } from '@/api/types';
   import { tenderKeys } from '@/features/tenders/tenderApi';

   export const risksKeys = { list: (tenderId: ID) => [...tenderKeys.detail(tenderId), 'risks'] as const };
   export const listRisks = (tenderId: ID) => api.get<ListResponse<Risk>>(`/tenders/${tenderId}/risks`).then((r) => r.items);
   export const createRisk = (tenderId: ID, body: Partial<Risk>) => api.post<Risk>(`/tenders/${tenderId}/risks`, body);
   ```

   ```tsx
   // in the tab
   const { tenderId, canWrite, T, tMinus } = useTender();          // from '@/features/tenders/tenderContext'
   const toast = useToast();
   const queryClient = useQueryClient();
   const risks = useQuery({ queryKey: risksKeys.list(tenderId), queryFn: () => listRisks(tenderId) });
   const create = useMutation({
     mutationFn: (body: Partial<Risk>) => createRisk(tenderId, body),
     onSuccess: () => { void queryClient.invalidateQueries({ queryKey: risksKeys.list(tenderId) }); toast.success(t('common:state.saved')); },
     onError: (err) => toast.error(errorMessage(err)),              // errorMessage from '@/api/client'
   });
   ```

   Query keys under `tenderKeys.detail(id)` are invalidated together when you invalidate the tender. After changing
   the tender record itself (deadline, status, flags) call `refetch()` from `useTender()`.

2. **Text** — `const { t } = useTranslation('<your namespace>')`; add keys to `src/i18n/el/<namespace>.json` only.
   Shared words (buttons, states, errors) are in `common` (`t('common:actions.save')`). Enum labels:
   `enumLabel('requirement_status', row.status)`, `enumOptions('requirement_type', REQUIREMENT_TYPES)` and
   `<StatusBadge kind="gate_decision" value={gate.decision} />` — never hard-code Greek enum labels or their colours.

3. **Types** — entities and enum unions/arrays are in `src/api/types.ts` (snake_case DB columns, English enum values,
   pure dates as `'YYYY-MM-DD'`, timestamps as ISO strings). Response shapes specific to one endpoint (joined rows,
   computed fields) go in your `*Api.ts`.

4. **Dates** — never `new Date('YYYY-MM-DD')`. Display with `<DateText>`; compute with `lib/dates.ts`
   (`todayAthens`, `athensDate`, `addDays`, `workingDaysBetween`, `formatTMinus`, `athensLocalToIso` …). Scheduling
   rules (R4–R10) are the server's job; the client only displays.

5. **Permissions** — `useAuth()` → `{ user, org, hasRole('admin','bid_manager'), isAdmin, canEdit }`;
   `useTender().canWrite / canSeeFinancial`. These only hide controls; the server enforces.

### Context/hook reference

| Hook | From | Gives |
| --- | --- | --- |
| `useAuth()` | `@/features/auth/AuthProvider` | `status, user, org, hasRole(...roles), isAdmin, canEdit, sessionExpired, refresh(), logout()` |
| `useCurrentUser()` | same | `{ user, org }` non-null (inside the shell) |
| `useTender()` | `@/features/tenders/tenderContext` | `tender, tenderId, T, tMinus, isActive, canWrite, canSeeFinancial, refetch()` |
| `useUsers()` | `@/features/shared/useUsers` | `users, byId, nameOf(id)` + react-query state |
| `useWorkingDaysTo(date)` | `@/features/shared/useHolidays` | working days from today to a date (n of T−n), `null` while loading |
| `useToast()` | `@/ui` | `success(msg), error(msg), info(msg)` |

`api` (`@/api/client`): `api.get/post/put/patch/del<T>(path, body?, { query, signal })`,
`api.upload<T>(path, FormData | { file, files, fields })`, `api.downloadUrl(path, query?)`. Paths are relative to `/api`.
Errors are `ApiError { status, code, message, details, fieldErrors }`; a 401 anywhere sends the user to the login screen.

## UI kit (`import { … } from '@/ui'`)

Props are documented in each component file. Status colours: **red = blocking, orange = warning, green = ok**, info, neutral.

| Component | Usage |
| --- | --- |
| `Button` / `LinkButton` | `<Button variant="primary" icon="plus" loading={m.isPending} onClick={…}>Προσθήκη</Button>` · `<LinkButton to="/tenders/new" variant="primary">…</LinkButton>` (variants: primary, secondary, ghost, danger; `size="sm"`, `iconOnly`) |
| `Field` | `<Field label="Τίτλος" required hint="…" error={errors.title}><Input …/></Field>` — wires label/aria to the control inside |
| `Input` `Select` `Textarea` | native props; `<Select options={enumOptions('folder', REQUIREMENT_FOLDERS)} placeholder="Όλα" value={v} onChange={…} />` |
| `Checkbox` | `<Checkbox label="Ζητείται demo" checked={v} onChange={(e) => set(e.target.checked)} />` (own label, no Field) |
| `DateInput` | `<DateInput value={dueDate} onChange={setDueDate} />` — `'YYYY-MM-DD'` or `null` in/out |
| `DateTimeInput` | `<DateTimeInput value={deadlineIso} onChange={setDeadlineIso} />` — UTC ISO in/out, typed as Athens time |
| `Table` (+ `CellActions`) | `<Table columns={cols} rows={items} loading={q.isPending} onRowClick={open} rowTone={(r) => late(r) ? 'red' : undefined} stickyHeader dense emptyTitle="…" />` — scrolls sideways in its container; wrap row buttons in `<CellActions>` |
| `Modal` | `<Modal open={open} onClose={close} title="…" onSubmit={save} footer={<><Button onClick={close}>Άκυρο</Button><Button type="submit" variant="primary">Αποθήκευση</Button></>}>…</Modal>` (Esc/backdrop close, focus trap, sheet on phones) |
| `ConfirmDialog` | `<ConfirmDialog open={!!target} danger title="Διαγραφή" message="…" loading={m.isPending} onConfirm={…} onCancel={…} />` |
| `Badge` | `<Badge tone="orange" dot>Απόκλιση</Badge>` (prefer `StatusBadge` for enums) |
| `Banner` | `<Banner tone="red" title="Η εγγυητική δεν προλαβαίνει" actions={<Button size="sm">…</Button>}>…</Banner>` (red, orange, info, green) |
| `Tabs` | route mode: `<Tabs label="…" items={[{ key, label, to: 'gates', count: 2, countTone: 'red' }]} />` · controlled: `value` + `onChange` |
| `PageHeader` | `<PageHeader title="…" subtitle="…" actions={…} back={{ to, label }} />`; inside a tender tab use `level={2}` |
| `Card` | `<Card title="Κάλυψη register" actions={…} tone="orange" flush>…</Card>` (`flush` when the body is a Table) |
| `EmptyState` | `<EmptyState icon="inbox" title="Δεν υπάρχουν tasks" description="…" action={<Button>…</Button>} compact />` |
| `Spinner` / `PageSpinner` | `<Spinner />` inline · `<PageSpinner />` while a page/tab loads |
| `ToastProvider` / `useToast` | `toast.success(t('common:state.saved'))`, `toast.error(errorMessage(err))` |
| `DateText` | `<DateText value={row.due_date} />` → 07/05/2027 · `withTime` → 07/05/2027 14:00 · `withWeekday` → Παρ 07/05/2027 |
| `TMinus` | `<TMinus n={tMinus} />` → chip «T−5» (auto: ≤2 red, ≤5 orange) · `<TMinus n={8} tone="neutral" plain />` in tables |
| `FileDropInput` | `<FileDropInput accept=".csv,.xlsx" multiple onFiles={setFiles} onReject={toast.error} files={files} onRemove={…} />` (200 MB default limit) |
| `FilterBar` | `<FilterBar search={{ value, onChange }} active={hasFilters} onReset={reset} summary="42 γραμμές"><Field label="Τύπος"><Select …/></Field></FilterBar>` |
| `ProgressBar` | `<ProgressBar label="Αποκλεισμού" value={covered} max={total} valueText={`${covered}/${total}`} />` (auto tone: 100% green, ≥50% orange, else red) |
| `Menu` | `<Menu label="Ενέργειες" items={[{ label: 'Επεξεργασία', icon: 'edit', onSelect }, { label: 'Διαγραφή', danger: true, separatorBefore: true, onSelect }]} />` |
| `Pagination` | `<Pagination offset={offset} limit={50} total={total} onChange={setOffset} />` |
| `Icon` | `<Icon name="alert" />` — the inline-SVG set in `ui/icons.tsx`; add paths there, no icon packages |

Utilities in `styles/base.css`: `.u-stack`, `.u-row`, `.u-form-grid` (+ `.u-span-2`), `.u-grid`, `.u-mono`, `.u-muted`,
`.u-sr-only`, `.u-truncate`. Feature CSS (rarely needed) goes in the feature folder and uses the tokens only.

## Assumed API shapes

The server was built in parallel. Assumptions are isolated, one file each, with the contract in the file header:
`features/auth/authApi.ts`, `features/tenders/tenderApi.ts`, `features/shared/useUsers.ts`,
`features/shared/holidaysApi.ts`, `features/admin/{usersApi,holidaysApi,auditApi}.ts`.
