# End-to-end run

`full-flow.mjs` drives the real product — a private PostgreSQL database, the real server serving the built web app,
Chromium through Playwright, **no API mocking** — through the story a bid team lives:

admin logs in and enrols 2FA → invites a bid manager, three members (roles Α/Β/Γ), an approver (Διοίκηση) and a
viewer, who accept and enrol → the bid manager creates a tender from «L v1.1» (demo + partners) and staffs the team
→ register import from a 40-row CSV (twice: no duplicates), edits, evidence, deviation → files in five folders
including «Οικονομική» (R18 in the UI and by direct URL; blobs encrypted on disk) → task, checklist, handoff
delivered by Β and received by Α → guarantee requested on the watchlist → company documents (one expiring before T)
linked: red on the tender, the G4 criterion and the dashboard → G0 requested, the approver decides Go → G1 «approved
with exception», G2 approved → deadline extension with diff, manual milestone flagged and reviewed, change log →
dashboards, «Τα δικά μου», digest preview, digest sent twice (idempotent), event e-mails in `email_log`, the daily
jobs through the job runner twice (`job_run`) → guarantee arrives, lesson, template v1.2 published → non-member
cannot open a tender, admin password reset link, tender closed as submitted and read-only on every tab → the main
screens again at 375 px.

```bash
npm run build -w web            # the run serves web/dist (or pass --build)
node web/e2e/full-flow.mjs      # ≈ 2 minutes; exit code 0 = no failed assertion and nothing suspicious noted
node web/e2e/full-flow.mjs --until=files   # stop after a phase (admin, accept, tender, team, register, files, tasks,
                                           # watch, documents, gate-g0, gates-later, extension, coordination, wrap-up,
                                           # close, mobile)
node web/e2e/full-flow.mjs --keep          # keep the database for a look afterwards
```

Needs: the local PostgreSQL (role with CREATEDB; `E2E_ADMIN_DATABASE_URL` overrides the default dev URL), port 3399
free (`E2E_PORT`), and Playwright with Chromium installed globally (it is not a dependency of this repository).
The run creates database `bidmanager_e2e_<pid>`, migrates and seeds it, starts the server on the port, and drops
everything at the end.

Output in `web/e2e/out/` (git-ignored): `screenshots/NNN-name.png` (1280 px; `mobile-*` at 375 px), `server.log`,
`register-import.csv`, and `report.json` with the failed assertion (if any), the toasts seen, and the `problems`
list. Besides the explicit assertions, every screenshot's page text is scanned for raw i18n keys, ISO dates,
English sentences, `undefined`/`NaN`, and horizontal page overflow; console errors, page errors and 5xx answers are
collected. Any of these makes the run fail.

`run-jobs.mts` is the helper the flow uses to run the registered daily jobs through `runJob()`.
