import { describe, expect, it, vi } from 'vitest';
import { logger } from './logger.js';
import { sendMail, sendMailWith, testOutbox } from './mailer.js';

describe('mailer (review M3)', () => {
  const mail = { to: 'maria@example.com', subject: 'Πρόσκληση στο Bid Manager', text: 'Ο σύνδεσμος: https://bids.example.gr/invite/SECRET-TOKEN-123' };

  it('without SMTP nothing is sent: returns false and logs recipient + subject only — never the body or a link', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      expect(await sendMailWith(mail, { isTest: false, host: undefined })).toBe(false);
      const logged = JSON.stringify([...warn.mock.calls, ...info.mock.calls]);
      expect(logged).toContain('maria@example.com');
      expect(logged).toContain('Πρόσκληση');
      expect(logged).not.toContain('SECRET-TOKEN-123');
      expect(logged).not.toContain('invite/');
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it('under test the mail is captured and counts as sent', async () => {
    testOutbox.length = 0;
    expect(await sendMail(mail)).toBe(true);
    expect(testOutbox).toEqual([mail]);
  });
});
