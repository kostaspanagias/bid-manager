# Bid Manager MVP — Τεχνική προδιαγραφή

Nov 13, 2026 · @Kostas Panagias

Εφαρμογή διαχείρισης έργου ειδικά για την κατάθεση μεγάλων δημόσιων διαγωνισμών, που υλοποιεί το [Blueprint κατάθεσης μεγάλων δημόσιων διαγωνισμών](https://claude.ai/artifact/826YjjytGQ5PjgzsY5BgRk). Single-tenant στο MVP, tenant-ready από την πρώτη μέρα.

## Σκοπός και πεδίο MVP

Το MVP κάνει ένα πράγμα καλά: οδηγεί μια ομάδα 3–5 ατόμων από τη δημοσίευση μιας διακήρυξης μέχρι την κατάθεση, με ανάστροφο πρόγραμμα, πύλες απόφασης και requirements register. Το περιεχόμενο της προσφοράς δεν γράφεται μέσα στην εφαρμογή.

| Μέσα στο MVP | Εκτός MVP (μετά) |
| --- | --- |
| Διαγωνισμοί με βασικά στοιχεία και αρχεία | Signup εταιρειών, billing, διαχείριση tenants |
| Ανάστροφος scheduler με ελληνικές αργίες | Διασύνδεση με ΕΣΗΔΗΣ / ΚΗΜΔΗΣ / TenderPro |
| Πύλες G0–G4 με κριτήρια εξόδου και έγκριση | AI μέσα στην εφαρμογή (ανάλυση, drafting) |
| Requirements register με import από CSV/XLSX | Σύνταξη εγγράφων προσφοράς μέσα στην εφαρμογή |
| Tasks/checklists ανά ρόλο από template | Gantt με drag & drop |
| Watchlist, κίνδυνοι, change log | Mobile app (το web είναι responsive) |
| Register εταιρικών εγγράφων με λήξεις | Αναφορές/BI πέρα από το dashboard |
| Email ειδοποιήσεις, dashboard, audit log | Αγγλικό UI |
| Lessons learned και εκδόσεις template |  |

## Χρήστες και δικαιώματα

Δύο επίπεδα ρόλων. Ο **ρόλος στον οργανισμό** ορίζει τι μπορεί να κάνει ο χρήστης στην εφαρμογή. Ο **ρόλος στον διαγωνισμό** (π.χ. «Δικαιολογητικά», «Τεχνική», «Οικονομική») είναι δεδομένο του template, όχι κώδικας, και ανατίθεται ανά διαγωνισμό.

| Ρόλος οργανισμού | Μπορεί να |
| --- | --- |
| Admin | Διαχειρίζεται χρήστες, templates, αργίες, εταιρικά έγγραφα. Ό,τι κάνει και ο Bid manager. |
| Bid manager | Δημιουργεί διαγωνισμούς, αναθέτει ρόλους, αλλάζει προθεσμίες, κλείνει διαγωνισμό |
| Member | Δουλεύει στους διαγωνισμούς όπου είναι μέλος: tasks, register, watchlist, κίνδυνοι, αρχεία |
| Approver | Ό,τι και Member + εγκρίνει πύλες που του έχουν ανατεθεί (π.χ. Διοίκηση στα G0, G2, G4) |
| Viewer | Βλέπει μόνο (π.χ. εταίρος ή διευθυντής) |

Οι τιμές της οικονομικής προσφοράς είναι ευαίσθητες: τα αρχεία του φακέλου «Οικονομική» τα βλέπουν μόνο ο υπεύθυνος οικονομικής, οι Approvers και ο Bid manager. Ένας Viewer δεν τα βλέπει ποτέ.

**Είσοδος:** email + κωδικός με υποχρεωτικό 2FA (TOTP). Δεν υπάρχει δημόσια εγγραφή· ο Admin στέλνει προσκλήσεις.

## Λειτουργίες MVP

Δέκα λειτουργικές ενότητες (F1–F10). Οι κανόνες που τις διέπουν είναι στην ενότητα «Επιχειρηματικοί κανόνες».

**F1 Διαγωνισμοί.** Δημιουργία με τίτλο, αναθέτουσα αρχή, ΑΔΑΜ, α/α ΕΣΗΔΗΣ, CPV, προϋπολογισμό (χωρίς/με ΦΠΑ), τμήματα, ημερομηνία δημοσίευσης (T0), προθεσμία ερωτημάτων, προθεσμία υποβολής (T, ημερομηνία + ώρα), ποσό και ισχύς εγγυητικής, ισχύς προσφοράς. Flags: «ζητείται demo», «υπάρχουν εταίροι». Upload διακήρυξης, παραρτημάτων και διευκρινίσεων. Κατάσταση: Αξιολόγηση → Σε εξέλιξη → Υποβλήθηκε / No-Go / Ακυρώθηκε.

**F2 Εφαρμογή template.** Στη δημιουργία επιλέγεται template (π.χ. «L v1.1»). Από αυτό δημιουργούνται ρόλοι, πύλες, milestones, tasks, checklists και watchlist items. Τα στοιχεία που εξαρτώνται από flags (demo, εταίροι) δημιουργούνται μόνο αν ισχύει το flag. Ο διαγωνισμός κρατά αντίγραφο (snapshot): οι αλλαγές στο template δεν επηρεάζουν διαγωνισμούς που τρέχουν.

**F3 Ανάστροφος scheduler.** Υπολογίζει τις ημερομηνίες όλων των milestones από το T. Ξανατρέχει σε αλλαγή προθεσμίας (παράταση) και δείχνει diff πριν την αποθήκευση. Χειροκίνητη αλλαγή ημερομηνίας σε milestone επιτρέπεται (σημαία «χειροκίνητο», δεν ξαναυπολογίζεται).

**F4 Πύλες.** Κάθε πύλη έχει ημερομηνία, approver και κριτήρια εξόδου. Κάθε κριτήριο είναι είτε χειροκίνητο (checkbox) είτε αυτόματο (π.χ. «απαιτήσεις αποκλεισμού με τεκμήριο = 100%»). Αποφάσεις: Εγκρίθηκε / Εγκρίθηκε με εξαίρεση (υποχρεωτική αιτιολόγηση) / Απορρίφθηκε. Στο G0 οι επιλογές είναι Go / No-Go.

**F5 Requirements register.** Γραμμές ΥΠ-nnn με τα πεδία του blueprint. Import από CSV/XLSX με αντιστοίχιση στηλών και προεπισκόπηση, export σε XLSX (φύλλο συμμόρφωσης). Φίλτρα ανά τύπο, φάκελο, υπεύθυνο, κατάσταση. Δείκτες κάλυψης ανά τύπο.

**F6 Tasks και handoffs.** Tasks με υπεύθυνο (ρόλο ή άτομο), ημερομηνία και κατάσταση. Ένα handoff είναι task με «από» και «προς»: ο παραλήπτης επιβεβαιώνει την παραλαβή. Λίστα «Τα δικά μου» ανά χρήστη, σε όλους τους διαγωνισμούς.

**F7 Watchlist, κίνδυνοι, change log.** Watchlist items με lead time (εργάσιμες ή ημερολογιακές), ημερομηνία αίτησης, αναμενόμενη και πραγματική άφιξη. Risk register (κίνδυνος, ένδειξη, αντίδραση, υπεύθυνος, κατάσταση). Change log (ημερομηνία, πηγή, περιγραφή, επηρεαζόμενες γραμμές ΥΠ, υπεύθυνος).

**F8 Εταιρικά έγγραφα (επίπεδο org).** Register με πιστοποιητικά (ISO, ΓΕΜΗ, ενημερότητες), CVs και έργα αναφοράς, με αρχείο, ημερομηνία έκδοσης και λήξης. Κάθε διαγωνισμός συνδέει τα έγγραφα που χρησιμοποιεί.

**F9 Ειδοποιήσεις και dashboard.** Ημερήσιο email digest ανά χρήστη (σήμερα, επόμενες 3 εργάσιμες, εκπρόθεσμα) και άμεσο email σε αίτημα έγκρισης πύλης και σε παράταση. Dashboard: ενεργοί διαγωνισμοί με T−n, επόμενη πύλη, κάλυψη register, εκπρόθεσμα, προειδοποιήσεις (συμπιεσμένο mode, λήξεις εγγράφων).

**F10 Templates, lessons learned, audit.** CRUD templates με εκδόσεις (μόνο Admin). Καταχώριση lessons learned ανά διαγωνισμό, με σημαία «αλλάζει το template». Audit log για κάθε αλλαγή (ποιος, τι, πότε, πριν/μετά).

## Μοντέλο δεδομένων

**Κάθε πίνακας έχει `org_id` (NOT NULL, FK στο `organization`)**, ακόμα και όταν μπορεί να βρεθεί μέσω parent. Μοναδικά κλειδιά περιλαμβάνουν το `org_id` (π.χ. `(org_id, email)`). Όλα τα ids είναι UUID. Κάθε πίνακας έχει `created_at`, `updated_at`, `created_by`.

| Οντότητα | Βασικά πεδία | Σχέσεις |
| --- | --- | --- |
| `organization` | name, timezone (Europe/Athens), settings (JSON) | γονέας όλων |
| `user` | email, name, org\_role, totp\_secret, active | — |
| `holiday` | date, name, source (εθνική / κινητή / χειροκίνητη) | — |
| `template` | name, version, status (draft / published), parent\_template\_id | → template\_items |
| `template_item` | kind (role / gate / milestone / task / handoff / checklist\_item / watch\_item / gate\_criterion), key, name, owner\_role\_key, offset\_value, offset\_unit (working / calendar), anchor (T / T0 / item key), condition (always / demo / partners), sort, payload (JSON) | template |
| `tender` | title, authority, adam, esidis\_no, cpv\[\], budget\_net, budget\_gross, lots (JSON), t0\_published\_at, questions\_deadline\_at, submission\_deadline\_at, guarantee\_amount, guarantee\_valid\_until, offer\_validity\_days, has\_demo, has\_partners, status, compressed\_mode, template\_id, template\_version | → όλα τα παρακάτω |
| `tender_member` | user\_id, tender\_role\_key | tender, user |
| `milestone` | key, name, kind (gate / milestone / handoff), due\_date, computed\_from (JSON), is\_manual, done\_at | tender |
| `gate` | milestone\_id, approver\_user\_id, decision (pending / approved / approved\_with\_exception / rejected / go / no\_go), justification, decided\_by, decided\_at | tender, milestone |
| `gate_criterion` | text, type (manual / auto), auto\_rule, checked\_by, checked\_at | gate |
| `requirement` | code (ΥΠ-nnn), source\_ref, text, type (exclusion / scored / formal), folder (participation / technical / financial), owner\_user\_id, response\_ref, evidence\_ref, status, deviation\_note | tender, ← change\_entry (m2m) |
| `task` | title, owner\_user\_id ή owner\_role\_key, due\_date, status, handoff\_from\_role, handoff\_to\_role, received\_by, received\_at, section | tender, milestone (προαιρ.) |
| `watch_item` | name, owner\_user\_id, lead\_value, lead\_unit, requested\_at, expected\_at, arrived\_at, notes | tender |
| `risk` | title, trigger, mitigation, owner\_user\_id, status | tender |
| `change_entry` | date, source (ΑΔΑΜ / ΕΣΗΔΗΣ / email), description, kind (διευκρίνιση / τροποποίηση / παράταση) | tender, ↔ requirement |
| `company_document` | type (iso / gemi / tax / insurance / cv / reference\_project / other), title, file\_id, issued\_at, expires\_at, person\_name (για CVs) | ↔ tender (m2m `tender_document`) |
| `file` | storage\_key, filename, mime, size, sha256, folder, confidentiality (normal / financial), uploaded\_by | tender (προαιρ.) |
| `lesson` | text, category, changes\_template, applied\_in\_version | tender |
| `audit_log` | user\_id, entity, entity\_id, action, before (JSON), after (JSON), at | — |

## Επιχειρηματικοί κανόνες

Τα R-κανόνια είναι αυτά που θέλουν unit tests. Οι προεπιλογές τιμές έρχονται από το template «L v1.1» και δεν γράφονται στον κώδικα.

**Ημερολόγιο**

- **R1 Εργάσιμη ημέρα** = Δευτέρα–Παρασκευή που δεν υπάρχει στο `holiday`.
- **R2 Αργίες (seed ανά έτος):** 1/1, 6/1, 25/3, 1/5, 15/8, 28/10, 25/12, 26/12 και οι κινητές από το Ορθόδοξο Πάσχα (Π): Καθαρά Δευτέρα (Π−48), Μ. Παρασκευή (Π−2), Δευτέρα του Πάσχα (Π+1), Αγίου Πνεύματος (Π+50). Το Π υπολογίζεται με τον αλγόριθμο Meeus (Ιουλιανό) + 13 ημέρες. Ο Admin μπορεί να προσθέσει, να μετακινήσει (π.χ. μετάθεση Πρωτομαγιάς) ή να αφαιρέσει αργίες.
- **R3 Ώρα:** αποθήκευση σε UTC, εμφάνιση σε Europe/Athens, μορφή dd/mm/yyyy. T = η ημερομηνία του `submission_deadline_at` σε ώρα Αθήνας.

**Scheduler**

- **R4 Offset σε εργάσιμες:** T−n = η n-οστή εργάσιμη πριν από το T. T0+n = η n-οστή εργάσιμη μετά το T0. Αν το anchor είναι άλλο item, μετράμε από την ημερομηνία εκείνου (π.χ. G0+2).
- **R5 Offset σε ημερολογιακές:** αφαιρούμε ημέρες και, αν το αποτέλεσμα δεν είναι εργάσιμη, πάμε στην προηγούμενη εργάσιμη.
- **R6 Watch item:** «τελευταία ημέρα αίτησης» = ημερομηνία που χρειάζεται − lead time (R4/R5). Η εγγυητική χρειάζεται στο G4 με lead 10 ημερολογιακές. Αν η τελευταία ημέρα αίτησης έχει περάσει χωρίς `requested_at`, εμφανίζεται κόκκινη προειδοποίηση.
- **R7 Defaults L v1.1:** G0 στόχος T0+3, αργότερο T−10 (αν T0+3 > T−12 → προειδοποίηση) · G1 T−8 · G2 T−4 · G3 T−3 · G4 T−2 · ανέβασμα T−1 · handoffs όπως στο blueprint.
- **R8 Συμπιεσμένο mode:** εργάσιμες από max(T0, σήμερα) έως T < 15 → `compressed_mode` = true, τα G1 και G2 συγχωνεύονται στο T−5 και εμφανίζεται πορτοκαλί banner. < 10 → κόκκινο banner «η εγγυητική δεν προλαβαίνει χωρίς άμεση αίτηση».
- **R9 Παράταση:** αλλαγή του T ξαναυπολογίζει όλα τα μη χειροκίνητα milestones, δείχνει diff πριν την αποθήκευση, σημαδεύει τα χειροκίνητα για έλεγχο και δημιουργεί αυτόματα `change_entry` (kind = παράταση). Μετά ξανατρέχουν τα R15 και R16.
- **R10 Completed items:** milestones με `done_at` δεν μετακινούνται σε ξαναυπολογισμό.

**Πύλες**

- **R11** Μόνο ο `approver_user_id` αποφασίζει. Ο Bid manager μπορεί να αλλάξει approver.
- **R12** Αν κάποιο κριτήριο δεν ικανοποιείται, επιτρέπεται μόνο «Εγκρίθηκε με εξαίρεση» με αιτιολόγηση ≥ 20 χαρακτήρες, που γράφεται στο audit log.
- **R13 Αυτόματα κριτήρια (`auto_rule`):** `exclusion_evidence_100` (G1: όλες οι απαιτήσεις αποκλεισμού έχουν τεκμήριο) · `register_no_open` (G3: καμία γραμμή Ανοιχτή / Σε εξέλιξη) · `handoffs_received` (όλα τα handoffs πριν την πύλη έχουν παραληφθεί) · `guarantee_arrived` (G4) · `docs_valid_on_T` (G4, R15).
- **R14 No-Go:** στο G0 το No-Go κλείνει τον διαγωνισμό (status = No-Go) και ακυρώνει τα ανοιχτά tasks.

**Έγγραφα και register**

- **R15 Λήξεις:** έγγραφο συνδεδεμένο με διαγωνισμό με `expires_at` < T → κόκκινο. Κάθε έγγραφο του org που λήγει σε ≤ 30 ημέρες → στο digest του Admin.
- **R16 Εγγυητική:** προειδοποίηση αν `guarantee_valid_until` < T + `offer_validity_days` + περιθώριο διακήρυξης (πεδίο ανά διαγωνισμό, default 30 ημέρες).
- **R17 Register:** το `code` είναι μοναδικό ανά διαγωνισμό. Το import κάνει upsert βάσει code και δεν σβήνει γραμμές. Η κατάσταση «Απόκλιση» θέλει σημείωση. Κάλυψη = (Καλύφθηκε + Ελέγχθηκε) / σύνολο, ανά τύπο.
- **R18 Οικονομικά αρχεία:** `file.confidentiality = financial` → τα βλέπουν μόνο ο κάτοχος ρόλου οικονομικής, ο Bid manager και οι Approvers. Έλεγχος στο backend, όχι μόνο στο UI.

## Αρχιτεκτονική

Ένας modular monolith με μία βάση και έναν χώρο αρχείων είναι αρκετός για το MVP. Δεν χρειάζονται microservices.

&#91;embedded content: αρχιτεκτονική MVP · monolith, 3 domain services, scoped data layer\]

**Κανόνες tenant-ready (απαράβατοι από την Φάση 1)**

1. Κάθε πίνακας έχει `org_id` NOT NULL. Το MVP έχει μία μόνο εγγραφή `organization`, από seed.
2. Η πρόσβαση στα δεδομένα γίνεται μόνο μέσα από ένα data layer που προσθέτει το `org_id` του τρέχοντος χρήστη. Κανένα raw query σε controllers.
3. Το `org_id` έρχεται από το session, ποτέ από το request body ή το URL.
4. Αρχεία σε `/{org_id}/{tender_id}/{file_id}`. Το αρχικό όνομα αρχείου μένει μόνο στη βάση.
5. Templates, ρόλοι, πύλες, offsets και αργίες είναι δεδομένα ανά org, όχι σταθερές στον κώδικα.
6. Αργότερα προστίθεται PostgreSQL Row-Level Security ως δεύτερο επίπεδο, χωρίς αλλαγές στο schema.

**Stack:** δική του developer επιλογή (βλ. Ανοιχτά θέματα), με δεσμευτικά: PostgreSQL, ένας μηχανισμός scheduled jobs, S3-compatible ή τοπικό κρυπτογραφημένο storage, deployment στην υποδομή μας.

## Μη λειτουργικές απαιτήσεις

Η εφαρμογή κρατά εμπιστευτικά δεδομένα (τιμές, εταίρους, στρατηγική) και προσωπικά δεδομένα (CVs). Αυτό είναι πιο κρίσιμο από την απόδοση.

| Περιοχή | Απαίτηση |
| --- | --- |
| Ασφάλεια πρόσβασης | Μόνο HTTPS · υποχρεωτικό 2FA · κωδικοί με Argon2id · rate limiting στο login · CSRF protection · λήξη session μετά από αδράνεια |
| Αρχεία | Αποθήκευση εκτός web root · download μόνο μέσω endpoint που ελέγχει δικαιώματα (R18) · κρυπτογράφηση at rest · όριο μεγέθους (προτείνεται 200 MB) · sha256 για ακεραιότητα |
| GDPR | CVs και στοιχεία μελών ομάδας = προσωπικά δεδομένα · πρόσβαση μόνο στους συμμετέχοντες του διαγωνισμού · διαγραφή δεδομένων ανά πρόσωπο με ένα action · ρυθμιζόμενος χρόνος διατήρησης αρχείων κλεισμένων διαγωνισμών |
| Backups | Ημερήσιο dump βάσης + αρχείων, κρυπτογραφημένο, σε δεύτερη τοποθεσία · διατήρηση 30 ημερών · δοκιμή επαναφοράς ανά τρίμηνο |
| Audit | Append-only, κανένας χρήστης δεν το σβήνει ή το αλλάζει |
| Jobs | Ημερήσια jobs (digest, λήξεις, R6) idempotent · τρέχουν 07:00 ώρα Αθήνας · log κάθε εκτέλεσης |
| Email | Μέσω SMTP provider με SPF/DKIM · χωρίς συνημμένα, μόνο links στην εφαρμογή |
| Απόδοση | Έως 50 χρήστες, έως 20 ενεργοί διαγωνισμοί · σελίδες < 1 s · register έως 1.000 γραμμές ανά διαγωνισμό |
| UI | Ελληνικά (με κείμενα σε αρχεία i18n από την αρχή) · responsive · συμβατό με τις δύο τελευταίες εκδόσεις Chrome, Edge, Firefox, Safari |
| Παρακολούθηση | Error tracking και health check endpoint |

## Φάσεις και κριτήρια αποδοχής

Τέσσερις φάσεις. Μετά τη Φάση 3 η εφαρμογή χρησιμοποιείται σε πραγματικό διαγωνισμό ως πιλοτική.

| Φάση | Περιεχόμενο |
| --- | --- |
| 1. Θεμέλια | Auth + 2FA, organization/users, μοντέλο δεδομένων με org\_id, scoped data access, file storage, audit log, αργίες (R1–R2) |
| 2. Πυρήνας | F1 διαγωνισμοί, F2 templates (seed «L v1.1»), F3 scheduler, F4 πύλες |
| 3. Εργασία ομάδας | F5 register (import/export), F6 tasks/handoffs, F7 watchlist/κίνδυνοι/change log, F8 εταιρικά έγγραφα |
| 4. Συντονισμός | F9 ειδοποιήσεις και dashboard, F10 lessons learned και εκδόσεις template |

**Κριτήρια αποδοχής (ως αυτοματοποιημένα tests)**

- [ ] Ορθόδοξο Πάσχα: 2026 → 12/04, 2027 → 02/05.
- [ ] Για T = Παρασκευή 07/05/2027: G4 = 05/05, G3 = 04/05, G2 = 29/04, G1 = 23/04, G0 αργότερο = 21/04 (παραλείπονται Μ. Παρασκευή 30/04 και Δευτέρα του Πάσχα 03/05).
- [ ] Ίδιο σενάριο: τελευταία ημέρα αίτησης εγγυητικής = G4 − 10 ημερολογιακές = Κυριακή 25/04 → Παρασκευή 23/04.
- [ ] Διαγωνισμός με 12 εργάσιμες από T0 έως T → compressed\_mode = true, G1 και G2 στο T−5.
- [ ] Παράταση +5 εργάσιμες: μετακινούνται μόνο τα μη χειροκίνητα και μη ολοκληρωμένα milestones · δημιουργείται change\_entry.
- [ ] Απόφαση πύλης με ανεκπλήρωτο κριτήριο χωρίς αιτιολόγηση → απορρίπτεται από το API.
- [ ] Viewer ή υπεύθυνος τεχνικής που ζητά οικονομικό αρχείο με απευθείας URL → 403.
- [ ] Import register δύο φορές με το ίδιο αρχείο → καμία διπλή γραμμή.
- [ ] Έγγραφο με λήξη πριν το T, συνδεδεμένο με διαγωνισμό → κόκκινο στο dashboard και αποτυχία του `docs_valid_on_T`.
- [ ] Κάθε query περνά από το scoped data layer: test με δεύτερο org στη βάση δείχνει ότι κανένα endpoint δεν επιστρέφει δεδομένα του.

## Ανοιχτά θέματα για τον developer

Θέλουν απάντηση πριν ξεκινήσει η Φάση 1.

- [ ] **Stack:** πρόταση με αιτιολόγηση. Προτίμηση: ίδιο stack με το TenderPro, για επαναχρησιμοποίηση κώδικα και εμπειρίας. Η βάση είναι PostgreSQL, εκτός αν υπάρχει σοβαρός λόγος.
- [ ] **Hosting:** σε ποια υποδομή και με ποιο deployment; Χρειάζονται PostgreSQL, scheduled jobs και ιδιωτικός χώρος αρχείων. Μια κοινή (shared) φιλοξενία Plesk μάλλον δεν αρκεί· πιθανότατα χρειάζεται VPS.
- [ ] **Import register:** ορισμός στηλών του CSV/XLSX (code, source\_ref, text, type, folder, owner) ώστε να το παράγουν αυτόματα τα AI εργαλεία ανάλυσης.
- [ ] **Email:** ποιος SMTP provider και από ποιο domain/αποστολέα.
- [ ] **Domain:** όνομα προϊόντος και subdomain για το MVP.
- [ ] **Εκτίμηση:** ανθρωποώρες και ημερομηνίες ανά φάση.
