# Bid Manager

Εφαρμογή διαχείρισης έργου για την κατάθεση μεγάλων δημόσιων διαγωνισμών. Οδηγεί μια ομάδα 3–5 ατόμων από τη
δημοσίευση της διακήρυξης μέχρι την κατάθεση: ανάστροφο πρόγραμμα από την προθεσμία υποβολής (T) με ελληνικές αργίες,
πύλες απόφασης G0–G4 με κριτήρια εξόδου και έγκριση, requirements register (ΥΠ-nnn) με import/export, tasks,
checklists και παραδόσεις ανά ρόλο, watchlist, κίνδυνοι, change log, εταιρικά έγγραφα με λήξεις, ειδοποιήσεις email,
dashboard, audit log, lessons learned και εκδόσεις template. Το περιεχόμενο της προσφοράς δεν γράφεται μέσα στην
εφαρμογή. Single-tenant σήμερα, tenant-ready από την πρώτη μέρα (κάθε πίνακας έχει `org_id`, κάθε query περνά από το
scoped data layer).

| | |
| --- | --- |
| Προδιαγραφή (δεσμευτική) | [`docs/spec.md`](docs/spec.md) · διαδικασία: [`docs/blueprint.md`](docs/blueprint.md) |
| Αρχιτεκτονική και συμβάσεις κώδικα | [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`server/README.md`](server/README.md) · [`web/README.md`](web/README.md) |
| Μορφή αρχείου import του register | [`docs/register-import-format.md`](docs/register-import-format.md) |
| Λειτουργία: backups, ρόλοι βάσης, συντήρηση | [`ops/README.md`](ops/README.md) |
| End-to-end σενάριο σε πραγματικό server | [`web/e2e/README.md`](web/e2e/README.md) |

**Stack:** Node 22 · TypeScript · Express 5 · PostgreSQL 16 (`pg`, χωρίς ORM) · React 19 + Vite · npm workspaces
(`server/`, `web/`). Ένα process: API, προγραμματισμένες εργασίες και σερβίρισμα του web app.

## Τοπική εκτέλεση

Χρειάζονται Node 22 και PostgreSQL 16 με μια βάση στην οποία ο ρόλος έχει δικαίωμα `CREATEDB` (τα tests φτιάχνουν και
σβήνουν δική τους βάση σε κάθε εκτέλεση).

```bash
npm install
cp server/.env.example server/.env
#   → συμπληρώστε FILE_ENCRYPTION_KEY (openssl rand -hex 32) — είναι υποχρεωτικό και στην ανάπτυξη
#   → DATABASE_URL αν δεν χρησιμοποιείτε την προεπιλεγμένη τοπική βάση
npm run migrate          # εφαρμόζει τα server/migrations/NNN_*.sql
npm run seed             # οργανισμός, πρώτος admin, αργίες (πέρσι … +2 έτη), template «L v1.1»
npm run dev:server       # API στο http://localhost:3001
npm run dev:web          # UI στο http://localhost:5173 (το Vite προωθεί το /api στον server)
```

Χωρίς `SMTP_HOST` δεν στέλνεται email: ο σύνδεσμος πρόσκλησης ή επαναφοράς κωδικού εμφανίζεται στον Admin στην οθόνη
(μία φορά) και το UI λέει ρητά ότι το email δεν στάλθηκε.

```bash
npm test                 # server: vitest (μονάδες, modules, acceptance suite) σε προσωρινή βάση
npm run typecheck        # server + web
npm run build            # server/dist + web/dist
node web/e2e/full-flow.mjs   # όλο το προϊόν σε πραγματικό server με Playwright (βλ. web/e2e/README.md)
```

Τα δέκα κριτήρια αποδοχής της προδιαγραφής είναι αυτοματοποιημένα στο
[`server/src/acceptance.test.ts`](server/src/acceptance.test.ts) — κάθε test έχει ως όνομα το ελληνικό κείμενο του
κριτηρίου και τρέχει μόνο μέσα από το HTTP API.

## Εγκατάσταση σε δική μας υποδομή (VPS)

Το προϊόν είναι ένα container (API + jobs + web app) δίπλα σε μια PostgreSQL 16, πίσω από reverse proxy που κάνει το
HTTPS. Υπάρχουν έτοιμα: [`Dockerfile`](Dockerfile) (multi-stage, non-root, μόνο production dependencies, health
check), [`docker-compose.yml`](docker-compose.yml) (app + postgres + Caddy, volumes για τη βάση και τα κρυπτογραφημένα
αρχεία), [`.env.example`](.env.example) (κάθε μεταβλητή με εξήγηση), [`ops/caddy/Caddyfile`](ops/caddy/Caddyfile) και
εναλλακτικά [`ops/nginx/bid-manager.conf`](ops/nginx/bid-manager.conf).

> **Τι έχει και τι δεν έχει εκτελεστεί.** Στο περιβάλλον όπου γράφτηκαν αυτά τα αρχεία δεν υπήρχε Docker daemon:
> **το image δεν έχει χτιστεί και το compose δεν έχει τρέξει ποτέ.** Αυτό που ελέγχθηκε πραγματικά (13/11/2026) είναι
> η ίδια διαδρομή χωρίς Docker: `npm run build`, migrations από το `dist` ως ιδιοκτήτης της βάσης, εκκίνηση με
> `node dist/index.js` και `NODE_ENV=production` με πραγματικό αρχείο env και **δεύτερο, περιορισμένο ρόλο βάσης**,
> σερβίρισμα του web app με τα σωστά cache headers και CSP, και πλήρες login (κωδικός + εγγραφή TOTP) μέσα από αυτό.
> Η πρώτη εκτέλεση του `docker compose up` θέλει δοκιμή σε staging πριν από την παραγωγή.

### Βήματα

```bash
git clone … && cd bid-manager
cp .env.example .env && chmod 600 .env
#   APP_DOMAIN / APP_URL          το domain (το DNS να δείχνει ήδη στον server)
#   DB_OWNER_PASSWORD / DB_APP_PASSWORD   openssl rand -hex 24  (δύο διαφορετικοί)
#   FILE_ENCRYPTION_KEY           openssl rand -hex 32  — ΑΝΤΙΓΡΑΦΟ ΣΤΟ PASSWORD MANAGER, χωριστά από τα backups
#   SMTP_*                        υποχρεωτικά στην παραγωγή
docker compose up -d --build
docker compose ps                 # το app πρέπει να γίνει «healthy» (GET /api/health)
```

- **`FILE_ENCRYPTION_KEY`**: 32 τυχαία bytes (64 δεκαεξαδικοί χαρακτήρες). Κρυπτογραφεί κάθε αρχείο (AES-256-GCM) και
  τα μυστικά 2FA των χρηστών. Αν χαθεί, τα αρχεία δεν ανοίγουν και όλοι οι χρήστες ξαναρυθμίζουν 2FA. Δεν αλλάζει σε
  σύστημα που έχει ήδη δεδομένα. Δεν περιλαμβάνεται στα backups.
- **Migrations**: τρέχουν αυτόματα σε κάθε εκκίνηση του container (idempotent, με advisory lock), ως ιδιοκτήτης της
  βάσης. Για ρητό βήμα: `RUN_MIGRATIONS=0` στο `.env` και
  `docker compose run --rm app node server/dist/db/migrate.js` πριν από κάθε αναβάθμιση.
- **Ρόλοι βάσης**: η εφαρμογή συνδέεται με περιορισμένο ρόλο (στον `audit_log` μόνο INSERT/SELECT, καθόλου DDL)· τα
  migrations τρέχουν με τον ιδιοκτήτη. Το compose το στήνει μόνο του· λεπτομέρειες και εγκατάσταση χωρίς Docker στο
  [`ops/README.md`](ops/README.md).
- **HTTPS και `TRUST_PROXY`**: η εφαρμογή δεν μιλά ποτέ απευθείας με το internet· το Caddy παίρνει και ανανεώνει το
  πιστοποιητικό και προωθεί στο `app:3001`. Το `TRUST_PROXY` είναι ο αριθμός των proxies μπροστά από την εφαρμογή
  (εδώ `1`): έτσι το rate limit του login και το κλείδωμα ανά διεύθυνση βλέπουν την πραγματική διεύθυνση του χρήστη.
  Με λάθος τιμή είτε όλοι οι χρήστες μοιράζονται ένα όριο (πολύ μικρή) είτε ο καθένας δηλώνει ό,τι διεύθυνση θέλει
  (πολύ μεγάλη). Στην παραγωγή ο server δεν ξεκινά αν δεν έχει οριστεί ρητά, ούτε χωρίς https `APP_URL`,
  `FILE_ENCRYPTION_KEY` ή `SMTP_HOST`.
- **Χωρίς Docker** (systemd): `npm ci && npm run build`, `npm run migrate:prod -w server`, `node server/dist/index.js`
  με τις ίδιες μεταβλητές (`NODE_ENV=production`, `DATABASE_URL`, `APP_URL`, `FILE_ENCRYPTION_KEY`, `SMTP_*`,
  `TRUST_PROXY`, `FILE_STORAGE_DIR` εκτός web root). Το `web/dist` σερβίρεται από το ίδιο process.

### Πρώτη εκκίνηση

1. **Seed** (μία φορά): `docker compose exec app node server/dist/db/seed.js` — δημιουργεί τον οργανισμό, τον πρώτο
   Admin (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`· αν ο κωδικός είναι κενός, τυπώνεται ένας τυχαίος μία φορά), τις
   αργίες και το template «L v1.1». Είναι idempotent.
2. **Είσοδος και 2FA**: ο Admin συνδέεται στο `https://<domain>/`, σαρώνει το QR με εφαρμογή authenticator και δίνει
   τον εξαψήφιο κωδικό. Το 2FA είναι υποχρεωτικό για όλους.
3. **Αργίες**: *Διαχείριση → Αργίες* — ελέγξτε το τρέχον και το επόμενο έτος (μεταθέσεις, τοπικές αργίες). Έτη που
   λείπουν συμπληρώνονται αυτόματα όταν ένας διαγωνισμός τα αγγίξει.
4. **Template**: *Διαχείριση → Templates* — το «L v1.1» είναι δημοσιευμένο· αλλαγές γίνονται σε νέα έκδοση.
5. **Χρήστες**: *Διαχείριση → Χρήστες → Πρόσκληση χρήστη* (δεν υπάρχει δημόσια εγγραφή). Χαμένος κωδικός:
   «Επαναφορά κωδικού» (σύνδεσμος μίας χρήσης, 24 ώρες)· χαμένο κινητό: «Επαναφορά 2FA».
6. **Backups**: στήστε το ημερήσιο `ops/backup.sh` και βάλτε στο ημερολόγιο τη δοκιμή επαναφοράς ανά τρίμηνο —
   [`ops/README.md`](ops/README.md).
7. Αν η εγκατάσταση χρησιμοποιήθηκε πριν από αυτή την έκδοση: το εφάπαξ βήμα «personal data in old audit rows» του
   [`ops/README.md`](ops/README.md).

### Παρακολούθηση

- `GET /api/health` → `200 {"status":"ok","db":"up"}` ή `503` όταν η βάση δεν απαντά. Το χρησιμοποιούν το health
  check του container και το Caddy.
- Logs: JSON (pino) στο stdout, με `X-Request-Id` σε κάθε απάντηση· ποτέ σώματα αιτημάτων, cookies ή κείμενα email.
- Error tracking: κάθε απρόβλεπτο σφάλμα (αίτημα που κατέληξε σε 500, αποτυχημένο job, unhandled rejection) περνά από
  το `server/src/core/errorTracking.ts`: γράφεται στο log με το request id και, αν οριστεί `ERROR_TRACKING_DSN`,
  στέλνεται ως JSON POST σε εκείνο το URL. Για SDK συγκεκριμένου παρόχου: `setErrorReporter()` στην εκκίνηση.
- Πίνακες `job_run` (κάθε εκτέλεση ημερήσιου job) και `email_log` (κάθε email, με κατάσταση).

## Μη λειτουργικές απαιτήσεις — πού υλοποιούνται

| Περιοχή | Απαίτηση (spec) | Κατάσταση | Πού |
| --- | --- | --- | --- |
| Ασφάλεια πρόσβασης | Μόνο HTTPS | Ναι, στο proxy· η εφαρμογή στέλνει HSTS, Secure cookie και αρνείται να ξεκινήσει με μη-https `APP_URL` | `ops/caddy/Caddyfile`, `server/src/config.ts`, `core/auth.ts` |
| | Υποχρεωτικό 2FA (TOTP) | Ναι· όριο λανθασμένων κωδικών ανά session και ανά χρήστη | `core/authRoutes.ts`, `core/totp.ts` |
| | Argon2id | Ναι | `core/password.ts` |
| | Rate limiting στο login | Ναι: ανά IP, και κλείδωμα ανά (λογαριασμό, διεύθυνση) μετά από 10 αποτυχίες | `core/rateLimit.ts`, `core/authRoutes.ts`, migration 003 |
| | CSRF | Ναι: `X-CSRF-Token` σε κάθε αίτημα που αλλάζει δεδομένα, cookie `SameSite=Lax` | `core/auth.ts` |
| | Λήξη session από αδράνεια | Ναι (`SESSION_IDLE_MINUTES`, προεπιλογή 30΄· απόλυτο όριο 12 ώρες) | `core/auth.ts` |
| Αρχεία | Εκτός web root, download μόνο μέσω endpoint με έλεγχο (R18) | Ναι | `core/storage.ts`, `modules/files`, `core/permissions.ts` |
| | Κρυπτογράφηση at rest | Ναι, AES-256-GCM ανά αρχείο | `core/storage.ts`, `core/crypto.ts` |
| | Όριο 200 MB, sha256 | Ναι | `modules/files/service.ts` |
| GDPR | Πρόσβαση μόνο στους συμμετέχοντες | Ναι: διαγωνισμοί ανά μέλος· CVs ορατά μόνο μέσω διαγωνισμού όπου είναι συνδεδεμένα· κατάλογος χρηστών μόνο όσων μοιράζονται διαγωνισμό | `core/permissions.ts`, `modules/company-documents`, `modules/users` |
| | Διαγραφή ανά πρόσωπο με ένα action | Ναι (*Εταιρικά έγγραφα → GDPR*)· ο audit log δεν κρατά πια ονόματα/emails | `modules/gdpr`, `db/scoped.ts` |
| | Ρυθμιζόμενη διατήρηση αρχείων κλεισμένων διαγωνισμών | Ναι (ημερήσιο job `gdpr-retention`) | `modules/gdpr` |
| Backups | Ημερήσιο κρυπτογραφημένο dump βάσης + αρχείων, 30 ημέρες, δοκιμή επαναφοράς | Scripts και διαδικασία έτοιμα και δοκιμασμένα· ο προγραμματισμός (cron) και η δεύτερη τοποθεσία είναι ευθύνη της εγκατάστασης | `ops/` |
| Audit | Append-only | Ναι: trigger στη βάση + (προτεινόμενο, έτοιμο στο compose) ρόλος εφαρμογής χωρίς UPDATE/DELETE | migration 001, `ops/README.md` |
| Jobs | Ημερήσια, idempotent, 07:00 Αθήνας, log κάθε εκτέλεσης | Ναι· αναπλήρωση αν χαθεί η εκτέλεση των 07:00 | `server/src/jobs`, `modules/*/jobs.ts`, πίνακας `job_run` |
| Email | SMTP provider, χωρίς συνημμένα, μόνο links | Ναι στον κώδικα· **SPF/DKIM και επιλογή παρόχου: δεν έχουν γίνει** (ανοιχτό θέμα της προδιαγραφής) | `core/mailer.ts`, `modules/notifications` |
| Απόδοση | 50 χρήστες, 20 ενεργοί διαγωνισμοί, σελίδες < 1 s, register 1.000 γραμμών | **Δεν έχει μετρηθεί.** Ο σχεδιασμός το στοχεύει (σταθερός αριθμός queries στο dashboard, virtualised πίνακας register) αλλά δεν υπάρχει load test | — |
| UI | Ελληνικά με i18n αρχεία | Ναι | `web/src/i18n/el/` |
| | Responsive | Ναι, ελεγμένο σε 1280 και 375 px | `web/e2e/full-flow.mjs` |
| | Δύο τελευταίες εκδόσεις Chrome, Edge, Firefox, Safari | **Ελέγχθηκε μόνο σε Chromium.** Firefox και Safari δεν έχουν δοκιμαστεί | — |
| Παρακολούθηση | Error tracking | Hook έτοιμο (log + προαιρετική προώθηση σε DSN)· **δεν έχει συνδεθεί εξωτερική υπηρεσία** | `core/errorTracking.ts` |
| | Health check endpoint | Ναι | `GET /api/health` |
| Υποδομή | Deployment σε δική μας υποδομή | Αρχεία έτοιμα· **image/compose δεν έχουν εκτελεστεί** (βλ. παραπάνω) | `Dockerfile`, `docker-compose.yml` |

## Τι δεν περιλαμβάνεται

Ό,τι η προδιαγραφή αφήνει εκτός MVP (signup εταιρειών, ΕΣΗΔΗΣ/ΚΗΜΔΗΣ, AI, Gantt, mobile app, αγγλικό UI), οθόνη για
το ιστορικό των email (`email_log` — υπάρχει μόνο το endpoint), PostgreSQL Row-Level Security (προβλέπεται ως δεύτερο
επίπεδο, χωρίς αλλαγή schema), και τα ανοιχτά θέματα της προδιαγραφής που δεν είναι κώδικας: πάροχος SMTP και
αποστολέας, domain, εκτίμηση ανθρωποωρών.
