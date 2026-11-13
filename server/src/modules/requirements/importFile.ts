// Reads an uploaded register file (CSV or XLSX) from memory into a plain grid of strings.
// Nothing is written to disk. The format is documented in docs/register-import-format.md.
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { unprocessable } from '../../core/errors.js';

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
const MAX_COLUMNS = 60;

export interface ParsedFile {
  format: 'csv' | 'xlsx';
  /** CSV: detected text encoding. */
  encoding?: 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1253';
  /** CSV: detected delimiter. */
  delimiter?: ',' | ';' | '\t';
  /** XLSX: all sheet names and the one that was read. */
  sheets: string[];
  sheet: string | null;
  /** Header cells (trimmed). */
  headers: string[];
  /** Data rows, each padded to headers.length; fully empty rows are dropped. */
  rows: string[][];
  /** 1-based line/row number in the file of each data row (for messages). */
  rowNumbers: number[];
}

const fail = (code: string, message: string, details?: unknown) => unprocessable(message, details, code);

export async function parseImportFile(buffer: Buffer, opts: { sheet?: string | null } = {}): Promise<ParsedFile> {
  if (!buffer || buffer.length === 0) throw fail('import_empty_file', 'The file is empty');
  const isZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
  const isOle = buffer.length > 8 && buffer.readUInt32BE(0) === 0xd0cf11e0;
  if (isOle) throw fail('import_unsupported_file', 'Old .xls workbooks are not supported: save the file as .xlsx or CSV');
  const grid = isZip ? await readXlsx(buffer, opts.sheet ?? null) : readCsv(buffer);
  return finish(grid);
}

type Grid = Omit<ParsedFile, 'headers' | 'rows' | 'rowNumbers'> & { cells: string[][]; firstLine: number };

function finish(grid: Grid): ParsedFile {
  const { cells, firstLine, ...meta } = grid;
  const isBlank = (row: string[]) => row.every((c) => c.trim() === '');
  const headerIndex = cells.findIndex((row) => !isBlank(row));
  if (headerIndex < 0) throw fail('import_empty_file', 'The file has no header row');
  let headers = (cells[headerIndex] as string[]).map((h) => h.trim());
  while (headers.length > 0 && headers[headers.length - 1] === '') headers = headers.slice(0, -1);
  if (headers.length > MAX_COLUMNS) throw fail('import_too_many_columns', `The file has more than ${MAX_COLUMNS} columns`);
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  for (let i = headerIndex + 1; i < cells.length; i++) {
    const src = cells[i] as string[];
    const row = headers.map((_, c) => (src[c] ?? '').replace(/\r\n?/g, '\n').trim());
    if (isBlank(row)) continue;
    rows.push(row);
    rowNumbers.push(firstLine + i);
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw fail('import_too_many_rows', `The file has ${rows.length} rows; the limit is ${MAX_IMPORT_ROWS}`, { rows: rows.length, limit: MAX_IMPORT_ROWS });
  }
  return { ...meta, headers, rows, rowNumbers };
}

// --------------------------------------------------------------------------------------------------------- CSV

function decodeText(buffer: Buffer): { text: string; encoding: NonNullable<ParsedFile['encoding']> } {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buffer.subarray(3)), encoding: 'utf-8' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buffer.subarray(2)), encoding: 'utf-16le' };
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buffer.subarray(2)), encoding: 'utf-16be' };
  if (buffer.includes(0)) throw fail('import_unsupported_file', 'The file is neither CSV nor XLSX');
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' };
  } catch {
    // Not valid UTF-8: Greek Excel saves "CSV" as Windows-1253. Every byte decodes to something there, so check
    // that the result looks like text (no undefined code points, no C1 control characters).
    const text = new TextDecoder('windows-1253').decode(buffer);
    // eslint-disable-next-line no-control-regex
    if (/[�\u0080-\u009f]/.test(text)) {
      throw fail('import_bad_encoding', 'The file is not UTF-8 (nor Windows-1253): save it as "CSV UTF-8" or as XLSX');
    }
    return { text, encoding: 'windows-1253' };
  }
}

function detectDelimiter(text: string): ',' | ';' | '\t' {
  // Count candidates outside quotes on the first non-empty line.
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  let seen = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (seen) break;
    } else {
      if (!inQuotes && ch in counts) counts[ch] = (counts[ch] as number) + 1;
      if (ch.trim() !== '') seen = true;
    }
  }
  if ((counts[';'] as number) > (counts[','] as number) && (counts[';'] as number) >= (counts['\t'] as number)) return ';';
  if ((counts['\t'] as number) > (counts[','] as number)) return '\t';
  return ',';
}

function readCsv(buffer: Buffer): Grid {
  const { text, encoding } = decodeText(buffer);
  const delimiter = detectDelimiter(text);
  let cells: string[][];
  try {
    cells = parse(text, { delimiter, relax_column_count: true, skip_empty_lines: false, relax_quotes: true, bom: true }) as string[][];
  } catch (err) {
    throw fail('import_unreadable_file', `The CSV file could not be read: ${(err as Error).message}`);
  }
  return { format: 'csv', encoding, delimiter, sheets: [], sheet: null, cells: cells.map((r) => r.map((c) => String(c ?? ''))), firstLine: 1 };
}

// -------------------------------------------------------------------------------------------------------- XLSX

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(15)));
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const v = value as { richText?: { text: string }[]; text?: unknown; result?: ExcelJS.CellValue; error?: string; hyperlink?: string };
    if (Array.isArray(v.richText)) return v.richText.map((p) => p.text).join('');
    if (v.result !== undefined) return cellText(v.result);
    if (v.text !== undefined) return cellText(v.text as ExcelJS.CellValue);
    if (typeof v.hyperlink === 'string') return v.hyperlink;
  }
  return '';
}

async function readXlsx(buffer: Buffer, wanted: string | null): Promise<Grid> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw fail('import_unreadable_file', 'The XLSX file could not be read');
  }
  const sheets = workbook.worksheets.map((ws) => ws.name);
  if (sheets.length === 0) throw fail('import_empty_file', 'The workbook has no sheets');
  const ws = wanted ? workbook.worksheets.find((s) => s.name === wanted) : workbook.worksheets[0];
  if (!ws) throw fail('import_unknown_sheet', `The workbook has no sheet "${wanted}"`, { sheets });
  const cells: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const out: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      if (col <= MAX_COLUMNS + 1) out[col - 1] = cellText(cell.value);
    });
    for (let i = 0; i < out.length; i++) out[i] ??= '';
    cells[rowNumber - 1] = out;
  });
  for (let i = 0; i < cells.length; i++) cells[i] ??= [];
  return { format: 'xlsx', sheets, sheet: ws.name, cells, firstLine: 1 };
}
