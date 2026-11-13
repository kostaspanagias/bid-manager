import { describe, expect, it } from 'vitest';
import { docsValidOnT, evaluateRule, exclusionEvidence100, guaranteeArrived, handoffsReceived, MAX_ITEMS, registerNoOpen, type RuleData } from './rules.js';

const req = (code: string, type: string, status: string, evidence_ref: string | null = null) => ({ code, type, status, evidence_ref });
const handoff = (title: string, due_date: string | null, received = false, status = 'open') => ({
  title, section: 'handoff', status, due_date, received_at: received ? new Date() : null,
});

describe('R13 exclusion_evidence_100', () => {
  it('is satisfied when every exclusion requirement has non-blank evidence; other types do not matter', () => {
    const r = exclusionEvidence100([req('ΥΠ-001', 'exclusion', 'covered', 'Παράρτημα Β.3'), req('ΥΠ-002', 'exclusion', 'open', 'σελ. 4'), req('ΥΠ-003', 'scored', 'open')]);
    expect(r).toMatchObject({ satisfied: true, detail: { code: 'exclusion_all_evidenced', total: 2, missing: 0, items: [] } });
  });

  it('fails and names the rows without evidence (blank counts as missing)', () => {
    const r = exclusionEvidence100([req('ΥΠ-001', 'exclusion', 'covered', 'x'), req('ΥΠ-002', 'exclusion', 'covered', '   '), req('ΥΠ-003', 'exclusion', 'covered', null)]);
    expect(r).toMatchObject({ satisfied: false, detail: { code: 'exclusion_missing_evidence', total: 3, missing: 2, items: ['ΥΠ-002', 'ΥΠ-003'] } });
  });

  it('zero exclusion requirements is NOT satisfied — an empty register proves nothing', () => {
    for (const rows of [[], [req('ΥΠ-001', 'formal', 'covered', 'x')]]) {
      const r = exclusionEvidence100(rows);
      expect(r).toMatchObject({ satisfied: false, detail: { code: 'exclusion_none', total: 0, missing: 0 } });
      expect(r.detail.message).toMatch(/empty register proves nothing/);
    }
  });

  it('lists at most a few codes but counts all', () => {
    const r = exclusionEvidence100(Array.from({ length: 9 }, (_, i) => req(`ΥΠ-00${i}`, 'exclusion', 'open')));
    expect(r.detail.missing).toBe(9);
    expect(r.detail.items).toHaveLength(MAX_ITEMS);
  });
});

describe('R13 register_no_open', () => {
  it('is satisfied when nothing is open / in progress (covered, verified, deviation all count as closed)', () => {
    const r = registerNoOpen([req('ΥΠ-001', 'exclusion', 'covered'), req('ΥΠ-002', 'scored', 'verified'), req('ΥΠ-003', 'formal', 'deviation')]);
    expect(r).toMatchObject({ satisfied: true, detail: { code: 'register_all_closed', total: 3, missing: 0 } });
  });

  it('fails with the open and in-progress codes', () => {
    const r = registerNoOpen([req('ΥΠ-001', 'exclusion', 'open'), req('ΥΠ-002', 'scored', 'in_progress'), req('ΥΠ-003', 'formal', 'covered')]);
    expect(r).toMatchObject({ satisfied: false, detail: { code: 'register_open_rows', total: 3, missing: 2, items: ['ΥΠ-001', 'ΥΠ-002'] } });
  });

  it('an empty register satisfies the rule literally and says so', () => {
    expect(registerNoOpen([])).toMatchObject({ satisfied: true, detail: { code: 'register_empty', total: 0 } });
  });
});

describe('R13 handoffs_received', () => {
  it('is satisfied when every handoff due up to the gate date has been received', () => {
    const r = handoffsReceived([handoff('Β → Α', '2027-04-22', true, 'done'), handoff('Α → Β', '2027-04-23', true, 'done')], '2027-04-23');
    expect(r).toMatchObject({ satisfied: true, detail: { code: 'handoffs_all_received', total: 2, missing: 0 } });
  });

  it('fails for an unreceived handoff due on or before the gate date', () => {
    const r = handoffsReceived([handoff('Β → Α', '2027-04-22', true), handoff('Α → Β πιστοποιητικά', '2027-04-23')], '2027-04-23');
    expect(r).toMatchObject({ satisfied: false, detail: { code: 'handoffs_pending', total: 2, missing: 1, items: ['Α → Β πιστοποιητικά'] } });
  });

  it('ignores handoffs after the gate, without a date, n/a or cancelled, and non-handoff tasks', () => {
    const r = handoffsReceived(
      [
        handoff('later', '2027-04-24'),
        handoff('no date', null),
        handoff('na', '2027-04-20', false, 'na'),
        handoff('cancelled', '2027-04-20', false, 'cancelled'),
        { ...handoff('plain task', '2027-04-20'), section: 'task' },
      ],
      '2027-04-23',
    );
    expect(r).toMatchObject({ satisfied: true, detail: { code: 'handoffs_none_due', total: 0 } });
  });

  it('a gate without a date cannot be evaluated', () => {
    expect(handoffsReceived([handoff('x', '2027-04-20', true)], null)).toMatchObject({ satisfied: false, detail: { code: 'gate_no_date' } });
  });
});

describe('R13 guarantee_arrived', () => {
  it('is satisfied when the watch item with key guarantee has arrived', () => {
    const r = guaranteeArrived([{ key: 'guarantee', name: 'Εγγυητική', arrived_at: '2027-05-03' }, { key: 'maf', name: 'MAF', arrived_at: null }]);
    expect(r).toMatchObject({ satisfied: true, detail: { code: 'guarantee_arrived' } });
  });

  it('fails when it has not arrived, or when there is no such watch item', () => {
    expect(guaranteeArrived([{ key: 'guarantee', name: 'Εγγυητική', arrived_at: null }])).toMatchObject({
      satisfied: false, detail: { code: 'guarantee_not_arrived', missing: 1, items: ['Εγγυητική'] },
    });
    expect(guaranteeArrived([{ key: 'maf', name: 'MAF', arrived_at: '2027-05-01' }])).toMatchObject({ satisfied: false, detail: { code: 'guarantee_missing' } });
  });
});

describe('R13 / R15 docs_valid_on_T', () => {
  const T = '2027-05-07';
  it('is satisfied when no linked document expires before T (expiry on T or none is fine)', () => {
    const r = docsValidOnT([{ title: 'ISO 9001', expires_at: '2027-05-07' }, { title: 'ΓΕΜΗ', expires_at: null }, { title: 'ISO 27001', expires_at: '2028-01-01' }], T);
    expect(r).toMatchObject({ satisfied: true, detail: { code: 'docs_all_valid', total: 3, missing: 0 } });
  });

  it('fails and names the documents expiring before T', () => {
    const r = docsValidOnT([{ title: 'ISO 9001', expires_at: '2027-05-06' }, { title: 'ΓΕΜΗ', expires_at: null }], T);
    expect(r).toMatchObject({ satisfied: false, detail: { code: 'docs_expired', total: 2, missing: 1, items: ['ISO 9001'] } });
  });

  it('no linked documents: satisfied, flagged in the detail', () => {
    expect(docsValidOnT([], T)).toMatchObject({ satisfied: true, detail: { code: 'docs_none_linked' } });
  });
});

describe('evaluateRule', () => {
  const data: RuleData = { requirements: [], handoffs: [], watchItems: [], linkedDocs: [], T: '2027-05-07' };
  it('dispatches by rule name and never passes an unknown rule', () => {
    expect(evaluateRule('exclusion_evidence_100', data, '2027-04-23').detail.code).toBe('exclusion_none');
    expect(evaluateRule('register_no_open', data, null).detail.code).toBe('register_empty');
    expect(evaluateRule('handoffs_received', data, '2027-04-23').detail.code).toBe('handoffs_none_due');
    expect(evaluateRule('guarantee_arrived', data, null).detail.code).toBe('guarantee_missing');
    expect(evaluateRule('docs_valid_on_T', data, null).detail.code).toBe('docs_none_linked');
    expect(evaluateRule('nope', data, null)).toMatchObject({ satisfied: false, detail: { code: 'unknown_rule' } });
  });
});

describe('R12 justification length (review L1)', () => {
  it('counts letters and digits after NFC normalisation; padding of any kind does not count', async () => {
    const { cleanJustification, justificationLength, MIN_JUSTIFICATION } = await import('./service.js');
    expect(justificationLength('Εγκρίνεται με εξαίρεση: εκκρεμεί η προσφορά.')).toBeGreaterThanOrEqual(MIN_JUSTIFICATION);
    expect(justificationLength('12345678901234567890')).toBe(20);
    for (const padded of [
      'ok' + ' '.repeat(40),
      '.'.repeat(40),
      'ok' + '\u200b'.repeat(40), // zero-width spaces
      'ok' + '\u0301'.repeat(40), // a pile of combining accents
      'ok\u202e' + '\u2060'.repeat(30), // bidi override + word joiners
      '👍'.repeat(25),
      '— – — – — – — – — – — – —',
    ]) {
      expect(justificationLength(padded), JSON.stringify(padded)).toBeLessThan(MIN_JUSTIFICATION);
    }
    // decomposed and precomposed Greek are the same text and the same length
    const nfd = 'Αιτιολόγηση εξαίρεσης πύλης'.normalize('NFD');
    expect(justificationLength(nfd)).toBe(justificationLength(nfd.normalize('NFC')));
    expect(cleanJustification(`\ufeff ${nfd}\u200b `)).toBe('Αιτιολόγηση εξαίρεσης πύλης');
  });
});
