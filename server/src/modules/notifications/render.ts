// E-mail content (Greek): plain text plus simple HTML, links into the app only, no attachments.
// Never put confidential values here: titles, codes, dates and counts only.
import { config } from '../../config.js';
import { dayOfWeek } from '../../domain/calendar.js';
import { formatDate } from '../../domain/time.js';
import type { Bucket, Digest, DigestItem, DigestTender } from './digest.js';
import type { DocRow, TenderTab, TenderWarning } from './snapshot.js';

export const SUBJECT_PREFIX = '[Bid Manager]';

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

const WEEKDAYS_SHORT = ['Κυρ', 'Δευ', 'Τρί', 'Τετ', 'Πέμ', 'Παρ', 'Σάβ'] as const;
const WEEKDAYS_LONG = ['Κυριακή', 'Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή', 'Σάββατο'] as const;

export const tenderUrl = (tenderId: string, tab: TenderTab = 'overview'): string => `${config.appUrl}/tenders/${tenderId}/${tab}`;
export const appUrl = (path: string): string => `${config.appUrl}${path}`;

const dateWd = (date: string): string => `${WEEKDAYS_SHORT[dayOfWeek(date)]} ${formatDate(date)}`;
const workingDays = (n: number): string => (n === 1 ? '1 εργάσιμη' : `${n} εργάσιμες`);
const tMinusLabel = (n: number): string => (n === 0 ? 'T (σήμερα)' : n > 0 ? `T−${n}` : `T+${-n}`);
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------------------------------------------
// A tiny document model so text and HTML always say the same thing
// ---------------------------------------------------------------------------------------------------------------

type Tone = 'red' | 'orange' | 'neutral';
type Block =
  | { type: 'p'; text: string }
  | { type: 'h'; text: string; meta?: string; url?: string }
  | { type: 'label'; text: string; tone?: Tone }
  | { type: 'list'; items: { text: string; tone?: Tone }[] }
  | { type: 'link'; label: string; url: string }
  | { type: 'rule' };

const TONE_COLOR: Record<Tone, string> = { red: '#9c1f14', orange: '#8a4705', neutral: '#1b232d' };

function toText(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'p':
        out.push(b.text, '');
        break;
      case 'h':
        out.push(`== ${b.text} ==`);
        if (b.meta) out.push(b.meta);
        if (b.url) out.push(b.url);
        out.push('');
        break;
      case 'label':
        out.push(b.text.toUpperCase());
        break;
      case 'list':
        for (const item of b.items) out.push(`  • ${item.text}`);
        out.push('');
        break;
      case 'link':
        out.push(`${b.label}: ${b.url}`, '');
        break;
      case 'rule':
        out.push('—'.repeat(40), '');
        break;
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function toHtml(blocks: Block[], preheader: string): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'p':
        parts.push(`<p style="margin:0 0 12px">${escapeHtml(b.text)}</p>`);
        break;
      case 'h': {
        const title = b.url
          ? `<a href="${escapeHtml(b.url)}" style="color:#14506b;text-decoration:none">${escapeHtml(b.text)}</a>`
          : escapeHtml(b.text);
        parts.push(
          `<h2 style="margin:20px 0 4px;font-size:16px;line-height:1.3">${title}</h2>` +
            (b.meta ? `<p style="margin:0 0 10px;color:#56606c;font-size:13px">${escapeHtml(b.meta)}</p>` : ''),
        );
        break;
      }
      case 'label':
        parts.push(
          `<p style="margin:10px 0 4px;font-size:12px;font-weight:bold;letter-spacing:.04em;text-transform:uppercase;color:${TONE_COLOR[b.tone ?? 'neutral']}">${escapeHtml(b.text)}</p>`,
        );
        break;
      case 'list':
        parts.push(
          `<ul style="margin:0 0 10px;padding-left:20px">${b.items
            .map((i) => `<li style="margin:0 0 4px;color:${TONE_COLOR[i.tone ?? 'neutral']}">${escapeHtml(i.text)}</li>`)
            .join('')}</ul>`,
        );
        break;
      case 'link':
        parts.push(`<p style="margin:0 0 12px"><a href="${escapeHtml(b.url)}" style="color:#14506b;font-weight:bold">${escapeHtml(b.label)}</a></p>`);
        break;
      case 'rule':
        parts.push('<hr style="border:0;border-top:1px solid #dedbd3;margin:16px 0">');
        break;
    }
  }
  return (
    '<!doctype html><html lang="el"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="margin:0;padding:16px;background:#f4f3ef;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;line-height:1.45;color:#1b232d">' +
    `<span style="display:none;max-height:0;overflow:hidden">${escapeHtml(preheader)}</span>` +
    `<div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #dedbd3;border-radius:8px;padding:20px 24px">${parts.join('')}</div>` +
    '</body></html>'
  );
}

const FOOTER_DIGEST = 'Λαμβάνετε αυτό το μήνυμα επειδή έχετε ενεργό το ημερήσιο digest. Το αλλάζετε από το Dashboard → Ειδοποιήσεις.';
const FOOTER_IMMEDIATE = 'Άμεση ειδοποίηση του Bid Manager. Την απενεργοποιείτε από το Dashboard → Ειδοποιήσεις.';

function finish(subject: string, blocks: Block[], footer: string): RenderedMail {
  const all: Block[] = [...blocks, { type: 'rule' }, { type: 'p', text: footer }];
  return { subject: clip(`${SUBJECT_PREFIX} ${subject}`, 200), text: toText(all), html: toHtml(all, subject) };
}

// ---------------------------------------------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------------------------------------------

const BUCKET_LABEL: Record<Bucket, string> = {
  overdue: 'Εκπρόθεσμα',
  today: 'Σήμερα',
  upcoming: 'Επόμενες 3 εργάσιμες',
  waiting: 'Περιμένουν ενέργειά σας',
};
const BUCKET_TONE: Record<Bucket, Tone> = { overdue: 'red', today: 'orange', upcoming: 'neutral', waiting: 'neutral' };

export function warningText(w: TenderWarning): string {
  const p = w.params;
  const list = (v: unknown): string => (Array.isArray(v) ? v.map((s) => `«${String(s)}»`).join(', ') : '');
  const more = (shown: unknown, count: unknown): string => (Array.isArray(shown) && Number(count) > shown.length ? ' κ.ά.' : '');
  switch (w.code) {
    case 'deadline_passed':
      return `Η προθεσμία υποβολής (${formatDate(String(p.T))}) πέρασε και ο διαγωνισμός είναι ακόμα ενεργός.`;
    case 'guarantee_urgent':
      return `Λιγότερες από 10 εργάσιμες έως το T (${Number(p.workingDays)}): η εγγυητική δεν προλαβαίνει χωρίς άμεση αίτηση.`;
    case 'documents_expiring':
      return Number(p.count) === 1
        ? `1 συνδεδεμένο έγγραφο λήγει πριν από το T: ${list(p.titles)}.`
        : `${Number(p.count)} συνδεδεμένα έγγραφα λήγουν πριν από το T: ${list(p.titles)}${more(p.titles, p.count)}.`;
    case 'watch_request_overdue':
      return Number(p.count) === 1
        ? `Watchlist: πέρασε η τελευταία ημέρα αίτησης για ${list(p.names)} χωρίς αίτηση.`
        : `Watchlist: πέρασε η τελευταία ημέρα αίτησης για ${Number(p.count)} στοιχεία (${list(p.names)}${more(p.names, p.count)}) χωρίς αίτηση.`;
    case 'gate_overdue':
      return `Η πύλη ${String(p.gate)}${p.dueDate ? ` (${formatDate(String(p.dueDate))})` : ''} δεν έχει αποφασιστεί.`;
    case 'compressed':
      return 'Συμπιεσμένο mode: λιγότερες από 15 εργάσιμες, οι πύλες G1 και G2 είναι συγχωνευμένες.';
    case 'guarantee_validity':
      return `Ισχύς εγγυητικής έως ${formatDate(String(p.validUntil))}· απαιτείται τουλάχιστον έως ${formatDate(String(p.requiredUntil))} (λείπουν ${Number(p.shortByDays)} ημέρες).`;
  }
}

function itemWhat(item: DigestItem): string {
  const roles = item.from || item.to ? ` (${item.from ?? '—'} → ${item.to ?? '—'})` : '';
  switch (item.kind) {
    case 'task':
      return `Task: ${item.title}`;
    case 'checklist':
      return `Checklist: ${item.title}`;
    case 'handoff_deliver':
      return `Παράδοση${roles}: ${item.title}`;
    case 'handoff_receive':
      return `Παραλαβή${roles}: ${item.title} — παραδόθηκε, περιμένει την επιβεβαίωσή σας`;
    case 'gate':
      return `Πύλη ${item.gateKey ?? ''} ${item.title}: περιμένει την απόφασή σας${item.requested ? ' (ζητήθηκε έγκριση)' : ''}`.replace(/\s+/g, ' ');
    case 'watch_request':
      return `Watchlist: ${item.title} — τελευταία ημέρα αίτησης`;
    case 'watch_arrival':
      return `Watchlist: ${item.title} — ${item.requested ? 'αναμενόμενη άφιξη' : 'πρέπει να είναι διαθέσιμο'}`;
  }
}

function itemWhen(item: DigestItem): string {
  if (!item.date) return '';
  const n = item.inWorkingDays ?? 0;
  if (n < 0 || item.bucket === 'overdue') return ` · ${dateWd(item.date)} (πριν από ${workingDays(Math.max(1, -n))})`;
  if (item.bucket === 'today') return ' · σήμερα';
  return ` · ${dateWd(item.date)} (σε ${workingDays(n)})`;
}

const itemLine = (item: DigestItem): string => `${itemWhat(item)}${itemWhen(item)}`;

function gatePhrase(g: NonNullable<DigestTender['nextGate']>): string {
  if (g.inWorkingDays === null || !g.dueDate) return `${g.key} χωρίς ημερομηνία`;
  if (g.overdue) return `${g.key} εκπρόθεσμη`;
  if (g.inWorkingDays === 0) return `${g.key} σήμερα`;
  return `${g.key} σε ${workingDays(g.inWorkingDays)}`;
}

function tenderMeta(t: DigestTender): string {
  const parts = [`Υποβολή: ${dateWd(t.T)} ${t.deadlineTime} · ${tMinusLabel(t.tMinus)}`];
  if (t.nextGate) parts.push(`Επόμενη πύλη: ${gatePhrase(t.nextGate)}${t.nextGate.dueDate ? ` (${dateWd(t.nextGate.dueDate)})` : ''}`);
  if (t.team && t.team.overdueTasks + t.team.overdueHandoffs > 0) {
    parts.push(`Ομάδα: ${t.team.overdueTasks} εκπρόθεσμα tasks, ${t.team.overdueHandoffs} εκπρόθεσμες παραδόσεις`);
  }
  return parts.join(' · ');
}

function docLine(d: DocRow, today: string): string {
  const when = d.expires_at ? formatDate(d.expires_at) : '—';
  return d.expires_at && d.expires_at < today ? `${d.title} — έληξε ${when}` : `${d.title} — λήγει ${when}`;
}

/** e.g. "3 εκπρόθεσμα · G2 σε 2 εργάσιμες — Προμήθεια εξοπλισμού". */
export function digestSubject(digest: Digest): string {
  const { totals, tenders } = digest;
  const parts: string[] = [];
  if (totals.overdue > 0) parts.push(totals.overdue === 1 ? '1 εκπρόθεσμο' : `${totals.overdue} εκπρόθεσμα`);
  if (totals.today > 0) parts.push(`${totals.today} για σήμερα`);
  const gate = tenders
    .map((t) => t.nextGate)
    .filter((g): g is NonNullable<DigestTender['nextGate']> => g !== null && g.inWorkingDays !== null && g.inWorkingDays <= 3)
    .sort((a, b) => (a.inWorkingDays ?? 0) - (b.inWorkingDays ?? 0))[0];
  if (gate) parts.push(gatePhrase(gate));
  if (parts.length < 3 && totals.upcoming > 0) parts.push(`${totals.upcoming} τις επόμενες 3 εργάσιμες`);
  if (parts.length < 3 && totals.waiting > 0) parts.push(totals.waiting === 1 ? '1 περιμένει εσάς' : `${totals.waiting} περιμένουν εσάς`);
  const red = tenders.reduce((n, t) => n + t.warnings.filter((w) => w.tone === 'red').length, 0);
  if (parts.length < 3 && red > 0) parts.push(red === 1 ? '1 κόκκινη προειδοποίηση' : `${red} κόκκινες προειδοποιήσεις`);
  if (parts.length < 3 && digest.orgDocuments.length > 0) {
    parts.push(digest.orgDocuments.length === 1 ? '1 εταιρικό έγγραφο λήγει' : `${digest.orgDocuments.length} εταιρικά έγγραφα λήγουν`);
  }
  if (parts.length === 0) parts.push(`Ημερήσια ενημέρωση ${formatDate(digest.date)}`);
  const scope = tenders.length === 1 ? ` — ${clip(tenders[0]?.title ?? '', 70)}` : tenders.length > 1 ? ` — ${tenders.length} διαγωνισμοί` : '';
  return `${parts.slice(0, 3).join(' · ')}${scope}`;
}

export function renderDigest(digest: Digest, user: { name: string }): RenderedMail {
  const { totals } = digest;
  const blocks: Block[] = [];
  blocks.push({ type: 'p', text: `Καλημέρα ${user.name},` });
  const summary = [
    `${totals.overdue} εκπρόθεσμα`,
    `${totals.today} για σήμερα`,
    `${totals.upcoming} τις επόμενες 3 εργάσιμες`,
    ...(totals.waiting > 0 ? [`${totals.waiting} περιμένουν ενέργειά σας`] : []),
  ].join(' · ');
  blocks.push({ type: 'p', text: `${WEEKDAYS_LONG[dayOfWeek(digest.date)]} ${formatDate(digest.date)} — ${summary}.` });

  for (const t of digest.tenders) {
    blocks.push({ type: 'h', text: t.authority ? `${t.title} — ${t.authority}` : t.title, meta: tenderMeta(t), url: tenderUrl(t.id) });
    if (t.warnings.length > 0) {
      blocks.push({ type: 'label', text: 'Προειδοποιήσεις', tone: t.warnings.some((w) => w.tone === 'red') ? 'red' : 'orange' });
      blocks.push({ type: 'list', items: t.warnings.map((w) => ({ text: warningText(w), tone: w.tone })) });
    }
    for (const bucket of ['overdue', 'today', 'upcoming', 'waiting'] as const) {
      const items = t.items.filter((i) => i.bucket === bucket);
      if (items.length === 0) continue;
      blocks.push({ type: 'label', text: `${BUCKET_LABEL[bucket]} (${items.length})`, tone: BUCKET_TONE[bucket] });
      blocks.push({ type: 'list', items: items.map((i) => ({ text: itemLine(i) })) });
    }
  }

  if (digest.orgDocuments.length > 0) {
    blocks.push({ type: 'h', text: 'Εταιρικά έγγραφα', meta: 'Έχουν λήξει ή λήγουν μέσα σε 30 ημέρες', url: appUrl('/company-documents') });
    blocks.push({
      type: 'list',
      items: digest.orgDocuments.map((d) => ({ text: docLine(d, digest.date), tone: d.expires_at && d.expires_at < digest.date ? ('red' as const) : undefined })),
    });
  }

  blocks.push({ type: 'link', label: 'Τα δικά μου', url: appUrl('/my') });
  blocks.push({ type: 'link', label: 'Dashboard', url: appUrl('/') });
  return finish(digestSubject(digest), blocks, FOOTER_DIGEST);
}

// ---------------------------------------------------------------------------------------------------------------
// Immediate e-mails
// ---------------------------------------------------------------------------------------------------------------

const DECISION_LABEL: Record<string, string> = {
  pending: 'Εκκρεμεί',
  approved: 'Εγκρίθηκε',
  approved_with_exception: 'Εγκρίθηκε με εξαίρεση',
  rejected: 'Απορρίφθηκε',
  go: 'Go',
  no_go: 'No-Go',
};

interface TenderRef {
  id: string;
  title: string;
}

export function renderApprovalRequested(o: {
  tender: TenderRef;
  gate: { key: string; name: string; dueDate: string | null; tMinus: number | null };
  recipientName: string;
  requestedBy: string | null;
}): RenderedMail {
  const gate = `${o.gate.key} ${o.gate.name}`.trim();
  const when = o.gate.dueDate ? ` Ημερομηνία πύλης: ${dateWd(o.gate.dueDate)}${o.gate.tMinus !== null ? ` (${tMinusLabel(o.gate.tMinus)})` : ''}.` : '';
  return finish(
    `Αίτημα έγκρισης ${o.gate.key} — ${clip(o.tender.title, 70)}`,
    [
      { type: 'p', text: `Γεια σας ${o.recipientName},` },
      { type: 'p', text: `${o.requestedBy ? `Ο/Η ${o.requestedBy} ζητά` : 'Ζητείται'} την απόφασή σας για την πύλη ${gate} του διαγωνισμού «${o.tender.title}».${when}` },
      { type: 'p', text: 'Τα κριτήρια εξόδου και η κατάστασή τους φαίνονται στην εφαρμογή.' },
      { type: 'link', label: 'Άνοιγμα της πύλης', url: tenderUrl(o.tender.id, 'gates') },
    ],
    FOOTER_IMMEDIATE,
  );
}

export function renderGateDecided(o: {
  tender: TenderRef;
  gate: { key: string; name: string };
  decision: string;
  decidedBy: string | null;
  recipientName: string;
}): RenderedMail {
  const label = DECISION_LABEL[o.decision] ?? o.decision;
  const gate = `${o.gate.key} ${o.gate.name}`.trim();
  const blocks: Block[] = [
    { type: 'p', text: `Γεια σας ${o.recipientName},` },
    { type: 'p', text: `Πύλη ${gate} του διαγωνισμού «${o.tender.title}»: ${label}${o.decidedBy ? ` — απόφαση από ${o.decidedBy}` : ''}.` },
  ];
  if (o.decision === 'approved_with_exception') blocks.push({ type: 'p', text: 'Η αιτιολόγηση της εξαίρεσης είναι καταγεγραμμένη στην εφαρμογή.' });
  if (o.decision === 'no_go') blocks.push({ type: 'p', text: 'Ο διαγωνισμός έκλεισε ως No-Go και τα ανοιχτά tasks ακυρώθηκαν.' });
  blocks.push({ type: 'link', label: 'Άνοιγμα των πυλών', url: tenderUrl(o.tender.id, 'gates') });
  return finish(`${o.gate.key}: ${label} — ${clip(o.tender.title, 70)}`, blocks, FOOTER_IMMEDIATE);
}

export function renderTenderExtended(o: {
  tender: TenderRef;
  /** Already formatted for display (dd/mm/yyyy [HH:mm]). */
  oldDeadline: string;
  newDeadline: string;
  tMinus: number | null;
  recipientName: string;
  changedBy: string | null;
}): RenderedMail {
  return finish(
    `Παράταση: νέα προθεσμία ${o.newDeadline} — ${clip(o.tender.title, 70)}`,
    [
      { type: 'p', text: `Γεια σας ${o.recipientName},` },
      { type: 'p', text: `Η προθεσμία υποβολής του διαγωνισμού «${o.tender.title}» άλλαξε${o.changedBy ? ` (καταχώριση: ${o.changedBy})` : ''}.` },
      {
        type: 'list',
        items: [
          { text: `Παλιά προθεσμία: ${o.oldDeadline}` },
          { text: `Νέα προθεσμία: ${o.newDeadline}${o.tMinus !== null ? ` (${tMinusLabel(o.tMinus)})` : ''}` },
        ],
      },
      { type: 'p', text: 'Το πρόγραμμα ξαναυπολογίστηκε. Ελέγξτε τις νέες ημερομηνίες σας, τα χειροκίνητα milestones, την ισχύ της εγγυητικής και των πιστοποιητικών.' },
      { type: 'link', label: 'Άνοιγμα του προγράμματος', url: tenderUrl(o.tender.id, 'schedule') },
    ],
    FOOTER_IMMEDIATE,
  );
}

export function renderHandoffDelivered(o: {
  tender: TenderRef;
  task: { title: string; from: string | null; to: string | null; dueDate: string | null };
  recipientName: string;
  deliveredBy: string | null;
}): RenderedMail {
  const roles = o.task.from || o.task.to ? ` (${o.task.from ?? '—'} → ${o.task.to ?? '—'})` : '';
  return finish(
    `Παράδοση προς παραλαβή: ${clip(o.task.title, 60)} — ${clip(o.tender.title, 60)}`,
    [
      { type: 'p', text: `Γεια σας ${o.recipientName},` },
      {
        type: 'p',
        text: `${o.deliveredBy ? `Ο/Η ${o.deliveredBy} παρέδωσε` : 'Παραδόθηκε'}: «${o.task.title}»${roles} στον διαγωνισμό «${o.tender.title}».${o.task.dueDate ? ` Προθεσμία παράδοσης: ${dateWd(o.task.dueDate)}.` : ''}`,
      },
      { type: 'p', text: 'Ελέγξτε το παραδοτέο και επιβεβαιώστε την παραλαβή στην εφαρμογή.' },
      { type: 'link', label: 'Επιβεβαίωση παραλαβής', url: tenderUrl(o.tender.id, 'tasks') },
    ],
    FOOTER_IMMEDIATE,
  );
}
