// XLSX output of the register: the compliance sheet (φύλλο συμμόρφωσης) and the empty import template.
// Both use the canonical Greek headers of importPlan.HEADER_NAMES, so the import reads them back unchanged.
import ExcelJS from 'exceljs';
import { HEADER_NAMES, formatOwner, type ExistingRow, type ImportField, type OwnerDirectory } from './importPlan.js';

/** Column order of the compliance sheet and of the template. */
export const SHEET_COLUMNS: { field: ImportField; width: number; wrap?: boolean }[] = [
  { field: 'code', width: 11 },
  { field: 'source_ref', width: 24, wrap: true },
  { field: 'text', width: 70, wrap: true },
  { field: 'type', width: 17 },
  { field: 'folder', width: 14 },
  { field: 'weight', width: 22, wrap: true },
  { field: 'owner', width: 22 },
  { field: 'response_ref', width: 30, wrap: true },
  { field: 'evidence_ref', width: 30, wrap: true },
  { field: 'status', width: 14 },
  { field: 'deviation_note', width: 36, wrap: true },
];

export const LABELS = {
  type: { exclusion: 'Αποκλεισμού', scored: 'Βαθμολογούμενη', formal: 'Τυπική' },
  folder: { participation: 'Συμμετοχής', technical: 'Τεχνική', financial: 'Οικονομική' },
  status: { open: 'Ανοιχτή', in_progress: 'Σε εξέλιξη', covered: 'Καλύφθηκε', verified: 'Ελέγχθηκε', deviation: 'Απόκλιση' },
} as const;
const label = (group: keyof typeof LABELS, value: string | null): string =>
  value === null ? '' : ((LABELS[group] as Record<string, string>)[value] ?? value);

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14506B' } };
const BORDER: Partial<ExcelJS.Borders> = { bottom: { style: 'thin', color: { argb: 'FFDEDBD3' } } };

function addRegisterSheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const ws = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
  ws.columns = SHEET_COLUMNS.map((c) => ({
    header: HEADER_NAMES[c.field].el,
    key: c.field,
    width: c.width,
    style: { alignment: { vertical: 'top', wrapText: Boolean(c.wrap) } },
  }));
  const header = ws.getRow(1);
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: 'middle', wrapText: false };
  });
  ws.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1' };
  return ws;
}

function lastColumnLetter(): string {
  return String.fromCharCode('A'.charCodeAt(0) + SHEET_COLUMNS.length - 1);
}

export async function buildComplianceSheet(rows: ExistingRow[], owners: OwnerDirectory, meta: { title: string }): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Bid Manager';
  workbook.title = `Φύλλο συμμόρφωσης — ${meta.title}`;
  const ws = addRegisterSheet(workbook, 'Φύλλο συμμόρφωσης');
  for (const r of rows) {
    const row = ws.addRow({
      code: r.code,
      source_ref: r.source_ref ?? '',
      text: r.text,
      type: label('type', r.type),
      folder: label('folder', r.folder),
      weight: r.weight ?? '',
      owner: formatOwner(r, owners),
      response_ref: r.response_ref ?? '',
      evidence_ref: r.evidence_ref ?? '',
      status: label('status', r.status),
      deviation_note: r.deviation_note ?? '',
    });
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = BORDER;
    });
  }
  ws.autoFilter = { from: 'A1', to: `${lastColumnLetter()}${Math.max(1, rows.length + 1)}` };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildTemplate(owners: OwnerDirectory): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Bid Manager';
  const ws = addRegisterSheet(workbook, 'Απαιτήσεις');
  ws.autoFilter = { from: 'A1', to: `${lastColumnLetter()}1` };
  const lists: Partial<Record<ImportField, string[]>> = {
    type: Object.values(LABELS.type),
    folder: Object.values(LABELS.folder),
    status: Object.values(LABELS.status),
  };
  SHEET_COLUMNS.forEach((c, i) => {
    const values = lists[c.field];
    if (!values) return;
    const letter = String.fromCharCode('A'.charCodeAt(0) + i);
    // exceljs has no public typing for range validations, but writes them correctly.
    (ws as unknown as { dataValidations: { add: (range: string, v: ExcelJS.DataValidation) => void } }).dataValidations.add(`${letter}2:${letter}2000`, {
      type: 'list',
      allowBlank: true,
      formulae: [`"${values.join(',')}"`],
      showErrorMessage: true,
      errorTitle: 'Μη αποδεκτή τιμή',
      error: `Επιτρεπόμενες τιμές: ${values.join(', ')}`,
    });
  });

  const help = workbook.addWorksheet('Οδηγίες');
  help.columns = [
    { header: 'Στήλη', key: 'col', width: 24 },
    { header: 'Αγγλικό όνομα', key: 'en', width: 18 },
    { header: 'Υποχρεωτική', key: 'req', width: 14 },
    { header: 'Επιτρεπόμενες τιμές / περιγραφή', key: 'desc', width: 100 },
  ];
  help.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = HEADER_FILL;
  });
  const roles = owners.roles.map((r) => (r.name && r.name !== r.key ? `${r.key} (${r.name})` : r.key)).join(', ');
  const enumHelp = (group: keyof typeof LABELS) =>
    Object.entries(LABELS[group])
      .map(([en, el]) => `${el} (${en})`)
      .join(' · ');
  const guide: Record<ImportField, [string, string]> = {
    code: ['Ναι', 'ΥΠ-nnn με ελληνικά γράμματα και τουλάχιστον 3 ψηφία, π.χ. ΥΠ-001. Μοναδικός ανά διαγωνισμό· γραμμή με κωδικό που υπάρχει ήδη ενημερώνεται, δεν διπλασιάζεται.'],
    source_ref: ['Όχι', 'Άρθρο, παράρτημα και σελίδα της διακήρυξης ή της διευκρίνισης, π.χ. «Παράρτημα Ι, §2.4.3, σελ. 45».'],
    text: ['Ναι (νέες γραμμές)', 'Η απαίτηση αυτούσια.'],
    type: ['Όχι (προεπιλογή: Τυπική)', enumHelp('type')],
    folder: ['Όχι', enumHelp('folder')],
    weight: ['Όχι', 'Μόνο για βαθμολογούμενες: κριτήριο και συντελεστής, ελεύθερο κείμενο, π.χ. «Κ2 – 15%».'],
    owner: ['Όχι', `Ρόλος του διαγωνισμού${roles ? ` (${roles})` : ' (π.χ. A, B, C)'} ή e-mail / ονοματεπώνυμο χρήστη. Ρόλος και χρήστης μαζί: «B; maria@example.gr».`],
    response_ref: ['Όχι', 'Κεφάλαιο ή έγγραφο της προσφοράς που καλύπτει την απαίτηση.'],
    evidence_ref: ['Όχι', 'Παράρτημα, σελίδα, § του τεκμηρίου, π.χ. «Παράρτημα Β.3, σελ. 12».'],
    status: ['Όχι (προεπιλογή: Ανοιχτή)', `${enumHelp('status')}. Η «Απόκλιση» θέλει αιτιολόγηση.`],
    deviation_note: ['Μόνο με «Απόκλιση»', 'Αιτιολόγηση της απόκλισης.'],
  };
  for (const c of SHEET_COLUMNS) {
    const [req, desc] = guide[c.field];
    help.addRow({ col: HEADER_NAMES[c.field].el, en: HEADER_NAMES[c.field].en, req, desc });
  }
  help.addRow({});
  for (const line of [
    'Η πρώτη γραμμή του φύλλου «Απαιτήσεις» είναι οι επικεφαλίδες· μία απαίτηση ανά γραμμή από τη 2η γραμμή.',
    'Το import δεν σβήνει ποτέ γραμμές. Πηγή, κείμενο, τύπος, φάκελος και συντελεστής ενημερώνονται πάντα από το αρχείο.',
    'Απάντηση, τεκμήριο, κατάσταση, αιτιολόγηση και υπεύθυνος συμπληρώνονται μόνο όπου είναι κενά, εκτός αν επιλεγεί «αντικατάσταση».',
    'Δεκτά αρχεία: XLSX ή CSV (UTF-8, διαχωριστικό , ή ;). Πλήρης περιγραφή: docs/register-import-format.md.',
  ]) {
    const row = help.addRow({ col: line });
    help.mergeCells(row.number, 1, row.number, 4);
  }
  help.eachRow((row) => {
    row.alignment = { vertical: 'top', wrapText: true };
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
