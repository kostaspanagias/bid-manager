# Requirements register — import file format

This is the column definition asked for by the open item «Import register» of `docs/spec.md`. A file that follows it
is imported into a tender's register (F5) without manual column mapping. It is written so that an AI analysis tool
(e.g. the tender-analysis skill) can produce the file directly from a διακήρυξη.

Implementation: `server/src/modules/requirements/` (`importFile.ts` reads the file, `importPlan.ts` holds the
header names, accepted values and merge rules, `codes.ts` the code format). The same layout is written by
**Export XLSX** (φύλλο συμμόρφωσης) and by **Λήψη υποδείγματος** (`GET …/requirements/template.xlsx`), so an export
can be edited and imported back.

## File

| | |
| --- | --- |
| Formats | `.xlsx` (Excel 2007+) or CSV. Old `.xls` is rejected. |
| XLSX | The first sheet is read (another sheet can be chosen in the wizard). Cell formatting is ignored; numbers, rich text and formula results are read as text. |
| CSV encoding | **UTF-8**, with or without BOM. UTF-16 with BOM (Excel «Unicode text») and Windows-1253 (Greek Excel «CSV») are detected and accepted; anything else is rejected with `import_bad_encoding`. |
| CSV delimiter | `,` or `;` (or TAB), detected from the header line. Quote a field with `"` when it contains the delimiter, a quote (doubled: `""`) or a line break. Line ends LF or CRLF. |
| Header | The first non-empty row. One requirement per following row; completely empty rows are skipped. |
| Limits | 5 MB, 5,000 data rows, 60 columns. |

The file is processed in memory and is not stored.

## Columns

Column order is free and extra columns are ignored. Headers are matched without regard to case, accents and
punctuation, in Greek or English. Use the canonical Greek header (first column below) or the English name.

| Header (Greek) | English name | Required | Content |
| --- | --- | --- | --- |
| `Κωδικός` | `code` | **yes** | Requirement code `ΥΠ-nnn` — see [Code](#code). Unique within the file. |
| `Πηγή` | `source_ref` | no | Article, annex and page of the διακήρυξη or clarification, e.g. `Παράρτημα Ι, §2.4.3, σελ. 45`. ≤ 500 chars. |
| `Κείμενο` | `text` | **yes** for new rows | The requirement verbatim. ≤ 20,000 chars. |
| `Τύπος` | `type` | no — default `Τυπική` | See [Type](#type). |
| `Φάκελος` | `folder` | no | See [Folder](#folder). |
| `Συντελεστής` | `weight` | no | Scored requirements only: criterion and coefficient, free text, e.g. `Κ2 – 15%`. ≤ 500 chars. |
| `Υπεύθυνος` | `owner` | no | See [Owner](#owner). |
| `Απάντηση` | `response_ref` | no | Chapter or document of the offer that covers it, e.g. `Κεφ. 3.2`. ≤ 1,000 chars. |
| `Τεκμήριο` | `evidence_ref` | no | Annex, page, § of the evidence, e.g. `Παράρτημα Β.3, σελ. 12`. ≤ 1,000 chars. |
| `Κατάσταση` | `status` | no — default `Ανοιχτή` | See [Status](#status). |
| `Αιτιολόγηση απόκλισης` | `deviation_note` | only with status `Απόκλιση` | Why the offer deviates. ≤ 5,000 chars. |

An AI analysis tool normally fills only `Κωδικός`, `Πηγή`, `Κείμενο`, `Τύπος`, `Φάκελος`, `Υπεύθυνος`
(and `Συντελεστής` for scored requirements) and leaves the rest to the team.

Other accepted header names: code — `Κωδ.`, `Κωδικός απαίτησης`, `ΥΠ`, `id`; source — `source`, `Παραπομπή`,
`Άρθρο`, `Αναφορά`, `reference`; text — `Απαίτηση`, `Κείμενο απαίτησης`, `Περιγραφή`, `requirement`, `description`;
type — `Είδος`, `category`; folder — `Υποφάκελος`; weight — `Βαρύτητα`, `Κριτήριο`, `Συντελεστής βαρύτητας`,
`criterion`; owner — `Ρόλος`, `role`, `assignee`; response — `response`, `Κεφάλαιο`; evidence — `evidence`,
`Τεκμηρίωση`; status — `state`; deviation note — `Σημείωση απόκλισης`, `Αιτιολόγηση`, `deviation`.
Any other column can be mapped by hand in the wizard.

### Code

Canonical form: **`ΥΠ-nnn`** — Greek capital upsilon (U+03A5) and pi (U+03A0), a hyphen-minus, and the number
zero-padded to at least three digits: `ΥΠ-001`, `ΥΠ-042`, `ΥΠ-1000`. Numbers run from 1 to 999999.

The import (and the app) normalise what is typed, so all of these are the **same** row `ΥΠ-001`:
`ΥΠ-001`, `ΥΠ-1`, `υπ 001`, `YΠ-1` (Latin Y), `YP-1`, `ΥΠ_01`, `ΥΠ–1` (en dash), `ΥΠ001`, `1`.
Anything else (`REQ-1`, `ΥΠ-1α`, `ΥΠ-1.2`) is an error for that row. Sub-numbering is not supported: give every
requirement its own number.

### Type

| Value stored | Greek | English | Also accepted |
| --- | --- | --- | --- |
| `exclusion` | `Αποκλεισμού` | `exclusion` | anything starting with `Αποκλεισμ…` or `Υποχρε…` (e.g. `Αποκλεισμού (ΥΠΟΧΡΕΩΣΗ)`, `Υποχρεωτική`), `mandatory` |
| `scored` | `Βαθμολογούμενη` | `scored` | `Βαθμολογ…`, `score` |
| `formal` | `Τυπική` | `formal` | `Τυπικ…` |

### Folder

| Value stored | Greek | English | Also accepted |
| --- | --- | --- | --- |
| `participation` | `Συμμετοχής` | `participation` | `Δικαιολογητικά συμμετοχής`, `Δικαιολογητικά` |
| `technical` | `Τεχνική` | `technical` | `Τεχνική προσφορά` |
| `financial` | `Οικονομική` | `financial` | `Οικονομική προσφορά` |

A cell naming two folders is an error.

### Status

| Value stored | Greek | English |
| --- | --- | --- |
| `open` | `Ανοιχτή` (or `Ανοικτή`) | `open` |
| `in_progress` | `Σε εξέλιξη` | `in_progress` |
| `covered` | `Καλύφθηκε` | `covered` |
| `verified` | `Ελέγχθηκε` | `verified` |
| `deviation` | `Απόκλιση` | `deviation` — needs `Αιτιολόγηση απόκλισης` (rule R17) |

### Owner

One of:

- a **role of the tender** by its key — `A`, `B`, `C` (the Greek letters `Α`, `Β`, `Γ` are read as A, B, C) — or by
  its name (e.g. `Τεχνική`);
- a **user** by e-mail (`maria@example.gr`) or by full name when the name is unique in the organization;
- a role and a user together, separated by `;` (also `/`, `|`, `·`): `B; maria@example.gr`.

An owner that cannot be resolved is a **warning**, not an error: the row is imported without changing its owner.

## Validation

Per row, reported in the preview with the row number of the file:

| Problem | Code | Effect |
| --- | --- | --- |
| No code / not a `ΥΠ-nnn` code | `missing_code`, `invalid_code` | row not imported |
| The same code twice in the file | `duplicate_code_in_file` | the second row is not imported |
| No text (new row, or empty text cell) | `missing_text` | row not imported |
| Unknown type / folder / status | `unknown_type`, `unknown_folder`, `unknown_status` | row not imported |
| Status `Απόκλιση` without a note | `deviation_note_required` | row not imported |
| Text longer than the limit | `value_too_long` | row not imported |
| Unknown or ambiguous owner | `unknown_owner`, `ambiguous_owner` | warning; owner left as is |

A file with errors is imported only when the user ticks «import the valid rows only»; the rows with errors are then
skipped and everything else is applied.

## Merge rules (R17)

The import is an **upsert by code** inside one transaction: a row whose code exists in the tender is updated, any
other row is created. **Rows are never deleted** — a requirement missing from the file stays in the register.
Importing the same file twice changes nothing («0 new, n unchanged»).

For a row that already exists:

| Fields | Rule |
| --- | --- |
| `Πηγή`, `Κείμενο`, `Τύπος`, `Φάκελος`, `Συντελεστής` (owned by the file) | Always follow the file when the column is present. An empty cell clears `Πηγή`, `Φάκελος`, `Συντελεστής`; an empty `Τύπος` keeps the current type; an empty `Κείμενο` is an error. |
| `Απάντηση`, `Τεκμήριο`, `Κατάσταση`, `Αιτιολόγηση απόκλισης`, `Υπεύθυνος` (owned by the team) | Taken from the file only where the register has nothing yet (empty text, status `Ανοιχτή`, no owner). Values the team entered are kept, and the preview says how many rows kept a value. With **«Αντικατάσταση»** (overwrite) ticked the file wins. An empty cell never clears these fields, with or without overwrite. |
| Columns that are not in the file | Untouched. |

So a re-run of the AI analysis after a clarification can be imported safely: wording, source and classification
follow the new file, the team's work stays.

## Example (CSV, UTF-8)

```csv
Κωδικός,Πηγή,Κείμενο,Τύπος,Φάκελος,Συντελεστής,Υπεύθυνος
ΥΠ-001,"Διακήρυξη §2.2.7, σελ. 31","Ο οικονομικός φορέας διαθέτει πιστοποίηση ISO 9001:2015 σε ισχύ.",Αποκλεισμού,Συμμετοχής,,A
ΥΠ-002,"Παράρτημα Ι, §3.1.4, σελ. 58","Κάθε εξυπηρετητής διαθέτει τουλάχιστον 2 επεξεργαστές και 256 GB μνήμης.",Αποκλεισμού,Τεχνική,,B
ΥΠ-003,"Διακήρυξη §2.3.1, Κ2, σελ. 40","Χρόνος αποκατάστασης βλάβης: βαθμολογείται ο χρόνος κάτω από τις ""8 ώρες"".",Βαθμολογούμενη,Τεχνική,Κ2 – 15%,B
ΥΠ-004,"Διακήρυξη §2.4.4, σελ. 47","Η οικονομική προσφορά υπογράφεται ψηφιακά από τον νόμιμο εκπρόσωπο.",Τυπική,Οικονομική,,C
```

The same in English names and values, with `;` as delimiter, is equally valid:

```csv
code;source_ref;text;type;folder;owner
ΥΠ-001;Διακήρυξη §2.2.7, σελ. 31;Ο οικονομικός φορέας διαθέτει πιστοποίηση ISO 9001:2015 σε ισχύ.;exclusion;participation;A
```

## API

`POST /api/tenders/:tenderId/requirements/import/preview` and `…/import/commit`, both `multipart/form-data`:

| Part | |
| --- | --- |
| `file` | the CSV/XLSX file (required) |
| `sheet` | XLSX sheet name (default: the first sheet) |
| `mapping` | JSON object `{ "<english field name>": <0-based column index> \| null }`; omit to use the detected mapping |
| `overwrite` | `true` to let the file replace team-owned fields |
| `skip_invalid` | commit only: `true` to import the valid rows of a file that has errors |

The preview writes nothing and returns the detected columns, the suggested mapping, the per-row plan
(`create` / `update` / `unchanged` / `error` with problems) and the counts. The commit takes the same parts again and
returns `{ created, updated, unchanged, skipped, total, overwrite }`.
