import { describe, expect, it } from 'vitest';
import { athensDate, athensTime, athensToUtc, formatDate, formatDateTime, todayAthens } from './time.js';

describe('R3 — Europe/Athens time helpers', () => {
  it('athensDate: T is the Athens-local date of the UTC deadline', () => {
    expect(athensDate('2027-05-07T12:00:00Z')).toBe('2027-05-07');
    expect(athensDate(new Date('2027-05-07T20:59:59Z'))).toBe('2027-05-07'); // 23:59 EEST
    expect(athensDate('2027-05-07T21:00:00Z')).toBe('2027-05-08'); // 00:00 EEST next day
    expect(athensDate('2027-01-15T21:59:59Z')).toBe('2027-01-15'); // 23:59 EET (UTC+2)
    expect(athensDate('2027-01-15T22:00:00Z')).toBe('2027-01-16');
    expect(athensDate('2026-12-31T22:30:00Z')).toBe('2027-01-01');
    expect(() => athensDate('garbage')).toThrow();
  });

  it('athensTime and formatting (dd/mm/yyyy)', () => {
    expect(athensTime('2027-05-07T12:00:00Z')).toBe('15:00');
    expect(athensTime('2027-01-15T22:05:00Z')).toBe('00:05');
    expect(formatDate('2027-05-07')).toBe('07/05/2027');
    expect(formatDateTime('2027-05-07T12:00:00Z')).toBe('07/05/2027 15:00');
    expect(formatDateTime('2027-01-15T22:05:00Z')).toBe('16/01/2027 00:05');
    expect(() => formatDate('7/5/2027')).toThrow();
  });

  it('todayAthens uses the given clock', () => {
    expect(todayAthens(new Date('2027-05-07T21:30:00Z'))).toBe('2027-05-08');
    expect(todayAthens()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('athensToUtc converts wall-clock time, DST-aware, and round-trips', () => {
    expect(athensToUtc('2027-05-07', '15:00').toISOString()).toBe('2027-05-07T12:00:00.000Z'); // EEST
    expect(athensToUtc('2027-01-15', '15:00').toISOString()).toBe('2027-01-15T13:00:00.000Z'); // EET
    expect(athensToUtc('2027-05-07').toISOString()).toBe('2027-05-06T21:00:00.000Z');
    expect(athensToUtc('2027-03-28', '02:30').toISOString()).toBe('2027-03-28T00:30:00.000Z'); // before the switch (03:00)
    expect(athensToUtc('2027-03-28', '12:00').toISOString()).toBe('2027-03-28T09:00:00.000Z'); // after the switch
    expect(athensToUtc('2027-10-31', '12:00').toISOString()).toBe('2027-10-31T10:00:00.000Z');
    for (const [d, t] of [['2027-05-07', '23:59'], ['2027-12-31', '00:00'], ['2027-03-27', '23:30'], ['2027-10-31', '05:00']] as const) {
      const utc = athensToUtc(d, t);
      expect(athensDate(utc)).toBe(d);
      expect(athensTime(utc)).toBe(t);
    }
    expect(() => athensToUtc('2027-05-07', '3pm')).toThrow();
  });
});
