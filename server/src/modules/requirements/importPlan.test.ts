import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  formatOwner,
  parseFolder,
  parseOwner,
  parseStatus,
  parseType,
  suggestMapping,
  type ExistingRow,
  type Mapping,
  type OwnerDirectory,
} from './importPlan.js';

const U1 = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';
const U3 = '00000000-0000-4000-8000-000000000003';
const owners: OwnerDirectory = {
  roles: [
    { key: 'A', name: 'Δικαιολογητικά' },
    { key: 'B', name: 'Τεχνική' },
    { key: 'C', name: 'Οικονομική' },
  ],
  users: [
    { id: U1, name: 'Μαρία Αντωνίου', email: 'maria@example.gr' },
    { id: U2, name: 'Γιώργος Δημητρίου', email: 'giorgos@example.gr' },
    { id: U3, name: 'Γιώργος Δημητρίου', email: 'g.dimitriou@example.gr' },
  ],
};

const HEADERS = ['Κωδικός', 'Πηγή', 'Κείμενο', 'Τύπος', 'Φάκελος', 'Συντελεστής', 'Υπεύθυνος', 'Απάντηση', 'Τεκμήριο', 'Κατάσταση', 'Αιτιολόγηση απόκλισης'];
const mapping: Mapping = suggestMapping(HEADERS);
const existingRow = (over: Partial<ExistingRow> = {}): ExistingRow => ({
  id: 'e1',
  code: 'ΥΠ-001',
  source_ref: '§2.1',
  text: 'Κείμενο',
  type: 'exclusion',
  folder: 'technical',
  weight: null,
  owner_user_id: null,
  owner_role_key: null,
  response_ref: null,
  evidence_ref: null,
  status: 'open',
  deviation_note: null,
  ...over,
});
const plan = (rows: string[][], existing: ExistingRow[] = [], overwrite = false, m: Mapping = mapping) =>
  buildPlan({ rows, rowNumbers: rows.map((_, i) => i + 2), mapping: m, existing, owners, overwrite });
const line = (over: Partial<Record<(typeof HEADERS)[number], string>> = {}) => HEADERS.map((h) => over[h] ?? '');

describe('import — header mapping and value normalisation', () => {
  it('maps Greek and English header names, whatever the case, accents or punctuation', () => {
    expect(suggestMapping(HEADERS)).toEqual({ code: 0, source_ref: 1, text: 2, type: 3, folder: 4, weight: 5, owner: 6, response_ref: 7, evidence_ref: 8, status: 9, deviation_note: 10 });
    expect(suggestMapping(['code', 'source_ref', 'text', 'type', 'folder', 'owner', 'response_ref', 'evidence_ref', 'status', 'weight'])).toMatchObject({
      code: 0, source_ref: 1, text: 2, type: 3, folder: 4, owner: 5, response_ref: 6, evidence_ref: 7, status: 8, weight: 9, deviation_note: null,
    });
    expect(suggestMapping(['ΚΩΔΙΚΟΣ', 'κειμενο ', 'Source', 'Άσχετη στήλη', 'Status:'])).toMatchObject({ code: 0, text: 1, source_ref: 2, status: 4, type: null });
    // a second column with the same meaning does not steal the mapping
    expect(suggestMapping(['Κωδικός', 'code']).code).toBe(0);
  });

  it('accepts Greek and English enum values', () => {
    expect(['Αποκλεισμού', 'ΑΠΟΚΛΕΙΣΜΟΥ', 'Αποκλεισμού (ΥΠΟΧΡΕΩΣΗ)', 'ΥΠΟΧΡΕΩΣΗ', 'exclusion', 'Exclusion'].map(parseType)).toEqual(Array(6).fill('exclusion'));
    expect(['Βαθμολογούμενη', 'βαθμολογούμενες', 'scored'].map(parseType)).toEqual(Array(3).fill('scored'));
    expect(['Τυπική', 'τυπικη', 'formal'].map(parseType)).toEqual(Array(3).fill('formal'));
    expect(parseType('Προαιρετική')).toBeNull();
    expect(['Συμμετοχής', 'Δικαιολογητικά συμμετοχής', 'participation'].map(parseFolder)).toEqual(Array(3).fill('participation'));
    expect(['Τεχνική', 'Τεχνική προσφορά', 'technical'].map(parseFolder)).toEqual(Array(3).fill('technical'));
    expect(['Οικονομική', 'ΟΙΚΟΝΟΜΙΚΗ ΠΡΟΣΦΟΡΑ', 'financial'].map(parseFolder)).toEqual(Array(3).fill('financial'));
    expect(parseFolder('Τεχνική / Οικονομική')).toBeNull(); // ambiguous
    expect(['Ανοιχτή', 'Ανοικτή', 'open'].map(parseStatus)).toEqual(Array(3).fill('open'));
    expect(['Σε εξέλιξη', 'in_progress', 'In progress'].map(parseStatus)).toEqual(Array(3).fill('in_progress'));
    expect(['Καλύφθηκε', 'covered'].map(parseStatus)).toEqual(Array(2).fill('covered'));
    expect(['Ελέγχθηκε', 'verified'].map(parseStatus)).toEqual(Array(2).fill('verified'));
    expect(['Απόκλιση', 'deviation'].map(parseStatus)).toEqual(Array(2).fill('deviation'));
    expect(parseStatus('done')).toBeNull();
  });

  it('reads an owner as role letter (Latin or Greek), role name, e-mail or unique name', () => {
    const role = (key: string) => ({ owner: { owner_user_id: null, owner_role_key: key } });
    expect(parseOwner('B', owners)).toEqual(role('B'));
    expect(parseOwner('Β', owners)).toEqual(role('B')); // Greek beta
    expect(parseOwner('γ', owners)).toEqual(role('C'));
    expect(parseOwner('Τεχνική', owners)).toEqual(role('B'));
    expect(parseOwner('MARIA@example.gr', owners)).toEqual({ owner: { owner_user_id: U1, owner_role_key: null } });
    expect(parseOwner('μαρια αντωνιου', owners)).toEqual({ owner: { owner_user_id: U1, owner_role_key: null } });
    expect(parseOwner('B; giorgos@example.gr', owners)).toEqual({ owner: { owner_user_id: U2, owner_role_key: 'B' } });
    expect(parseOwner('Γιώργος Δημητρίου', owners)).toEqual({ error: 'ambiguous_owner' });
    expect(parseOwner('Δ', owners)).toEqual({ error: 'unknown_owner' });
    expect(parseOwner('nobody@example.gr', owners)).toEqual({ error: 'unknown_owner' });
    // what the export writes is read back to the same owner
    for (const owner of [
      { owner_user_id: U1, owner_role_key: null },
      { owner_user_id: U2, owner_role_key: 'A' },
      { owner_user_id: U3, owner_role_key: null },
      { owner_user_id: null, owner_role_key: 'C' },
    ]) {
      expect(parseOwner(formatOwner(owner, owners), owners)).toEqual({ owner });
    }
    expect(formatOwner({ owner_user_id: U2, owner_role_key: 'A' }, owners)).toBe('A; giorgos@example.gr');
    expect(formatOwner({ owner_user_id: U1, owner_role_key: null }, owners)).toBe('Μαρία Αντωνίου');
  });
});

describe('import — per-row validation', () => {
  it('flags missing code/text, bad codes, unknown values and duplicates in the file', () => {
    const { rows, summary } = plan([
      line({ Κωδικός: 'ΥΠ-001', Κείμενο: 'ok', Τύπος: 'Αποκλεισμού', Φάκελος: 'Τεχνική', Υπεύθυνος: 'Β', Κατάσταση: 'Ανοιχτή' }),
      line({ Κείμενο: 'χωρίς κωδικό' }),
      line({ Κωδικός: 'ΥΠ-003' }),
      line({ Κωδικός: 'REQ-4', Κείμενο: 'x' }),
      line({ Κωδικός: 'ΥΠ-005', Κείμενο: 'x', Τύπος: 'Προαιρετική', Φάκελος: 'Νομική', Κατάσταση: 'Έτοιμο' }),
      line({ Κωδικός: 'YΠ-1', Κείμενο: 'διπλή' }),
      line({ Κωδικός: 'ΥΠ-007', Κείμενο: 'x', Κατάσταση: 'Απόκλιση' }),
      line({ Κωδικός: 'ΥΠ-008', Κείμενο: 'x', Υπεύθυνος: 'Κανένας' }),
    ]);
    const problems = rows.map((r) => [r.row, r.action, r.errors.map((e) => `${e.field}:${e.code}`), r.warnings.map((e) => `${e.field}:${e.code}`)]);
    expect(problems).toEqual([
      [2, 'create', [], []],
      [3, 'error', ['code:missing_code'], []],
      [4, 'error', ['text:missing_text'], []],
      [5, 'error', ['code:invalid_code'], []],
      [6, 'error', ['type:unknown_type', 'folder:unknown_folder', 'status:unknown_status'], []],
      [7, 'error', ['code:duplicate_code_in_file'], []],
      [8, 'error', ['status:deviation_note_required'], []],
      [9, 'create', [], ['owner:unknown_owner']],
    ]);
    expect(rows[5]?.errors[0]).toMatchObject({ firstRow: 2, value: 'YΠ-1' });
    expect(rows[4]?.errors[0]).toMatchObject({ value: 'Προαιρετική' });
    expect(rows[0]?.values).toEqual({ code: 'ΥΠ-001', text: 'ok', type: 'exclusion', folder: 'technical', owner: 'B', status: 'open' });
    expect(rows[0]?.data).toMatchObject({ code: 'ΥΠ-001', type: 'exclusion', folder: 'technical', owner_role_key: 'B', owner_user_id: null, status: 'open' });
    expect(summary).toEqual({ total: 8, create: 2, update: 0, unchanged: 0, errors: 6, warnings: 1, kept: 0 });
  });

  it('defaults a new row to type formal and status open; an unmapped code column fails every row', () => {
    const { rows } = plan([line({ Κωδικός: '12', Κείμενο: 'x' })]);
    expect(rows[0]?.data).toMatchObject({ code: 'ΥΠ-012', type: 'formal', status: 'open', folder: null });
    const none = plan([line({ Κωδικός: '12', Κείμενο: 'x' })], [], false, { ...mapping, code: null });
    expect(none.rows[0]?.errors).toEqual([{ field: 'code', code: 'missing_code' }]);
  });
});

describe('import — non-destructive merge (R17)', () => {
  const file = line({
    Κωδικός: 'υπ 1', Πηγή: '§2.4', Κείμενο: 'Νέο κείμενο', Τύπος: 'Βαθμολογούμενη', Φάκελος: 'Οικονομική', Συντελεστής: 'Κ1 – 20%',
    Υπεύθυνος: 'A', Απάντηση: 'Κεφ. 9', Τεκμήριο: 'Παρ. Γ', Κατάσταση: 'Ελέγχθηκε', 'Αιτιολόγηση απόκλισης': 'από το αρχείο',
  });

  it('always updates the file-owned fields and fills team-owned fields that are still empty', () => {
    const { rows, summary } = plan([file], [existingRow()]);
    expect(rows[0]).toMatchObject({ action: 'update', id: 'e1', kept: [] });
    expect(rows[0]?.patch).toEqual({
      source_ref: '§2.4', text: 'Νέο κείμενο', type: 'scored', folder: 'financial', weight: 'Κ1 – 20%',
      response_ref: 'Κεφ. 9', evidence_ref: 'Παρ. Γ', deviation_note: 'από το αρχείο', status: 'verified', owner_user_id: null, owner_role_key: 'A',
    });
    expect(summary).toMatchObject({ update: 1, create: 0, kept: 0 });
  });

  it('keeps what the team filled in the app unless overwrite is ticked', () => {
    const filled = existingRow({ response_ref: 'Κεφ. 3.2', evidence_ref: 'Παράρτημα Β.3, σελ. 12', status: 'covered', deviation_note: 'δική μας', owner_user_id: U1 });
    const kept = plan([file], [filled]);
    expect(kept.rows[0]?.patch).toEqual({ source_ref: '§2.4', text: 'Νέο κείμενο', type: 'scored', folder: 'financial', weight: 'Κ1 – 20%' });
    expect(kept.rows[0]?.kept.sort()).toEqual(['deviation_note', 'evidence_ref', 'owner', 'response_ref', 'status']);
    expect(kept.summary).toMatchObject({ update: 1, kept: 1 });

    const over = plan([file], [filled], true);
    expect(over.rows[0]?.kept).toEqual([]);
    expect(over.rows[0]?.patch).toMatchObject({ response_ref: 'Κεφ. 9', evidence_ref: 'Παρ. Γ', status: 'verified', deviation_note: 'από το αρχείο', owner_user_id: null, owner_role_key: 'A' });
  });

  it('an empty cell never clears a team-owned field, even with overwrite; it does clear source, folder and weight', () => {
    const filled = existingRow({ response_ref: 'Κεφ. 3.2', evidence_ref: 'Β.3', status: 'covered', owner_role_key: 'B', weight: 'Κ1' });
    const { rows } = plan([line({ Κωδικός: 'ΥΠ-001', Κείμενο: 'Κείμενο' })], [filled], true);
    expect(rows[0]?.patch).toEqual({ source_ref: null, folder: null, weight: null });
    expect(rows[0]?.changed.sort()).toEqual(['folder', 'source_ref', 'weight']);
  });

  it('columns that are not mapped are not touched; identical content is "unchanged"', () => {
    const e = existingRow({ response_ref: 'Κεφ. 3.2', status: 'covered' });
    const onlyCode = plan([['ΥΠ-001', 'Κείμενο']], [e], true, { code: 0, text: 1 });
    expect(onlyCode.rows[0]).toMatchObject({ action: 'unchanged', changed: [], kept: [] });
    expect(onlyCode.summary).toEqual({ total: 1, create: 0, update: 0, unchanged: 1, errors: 0, warnings: 0, kept: 0 });
    // text column not mapped at all: fine for an existing row, an error for a new one
    const noText = plan([['ΥΠ-001'], ['ΥΠ-002']], [e], false, { code: 0 });
    expect(noText.rows.map((r) => r.action)).toEqual(['unchanged', 'error']);
  });

  it('a legacy spelling in the database is matched and rewritten to the canonical code, not duplicated', () => {
    const { rows } = plan([['ΥΠ-001', 'Κείμενο']], [existingRow({ code: 'YΠ-1' })], false, { code: 0, text: 1 });
    expect(rows[0]).toMatchObject({ action: 'update', id: 'e1', patch: { code: 'ΥΠ-001' } });
  });

  it('refuses a merge that would leave a deviation without a note', () => {
    const { rows } = plan([line({ Κωδικός: 'ΥΠ-001', Κείμενο: 'Κείμενο', Κατάσταση: 'Απόκλιση' })], [existingRow()]);
    expect(rows[0]).toMatchObject({ action: 'error', errors: [{ field: 'status', code: 'deviation_note_required' }] });
    const withNote = plan([line({ Κωδικός: 'ΥΠ-001', Κείμενο: 'Κείμενο', Κατάσταση: 'Απόκλιση', 'Αιτιολόγηση απόκλισης': 'λόγος' })], [existingRow()]);
    expect(withNote.rows[0]?.patch).toMatchObject({ status: 'deviation', deviation_note: 'λόγος' });
  });
});
