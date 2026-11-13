import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { logger } from './logger.js';

export interface Mail {
  to: string;
  subject: string;
  /** Plain text. No attachments by design: mails only link into the app. */
  text: string;
  html?: string;
}

/** Tests: every mail "sent" under NODE_ENV=test lands here instead of going anywhere. */
export const testOutbox: Mail[] = [];

let transporter: Transporter | null = null;

/**
 * Sends one e-mail through the configured SMTP provider. Returns true when the mail was handed to the provider and
 * false when SMTP is not configured (SMTP_HOST empty — impossible in production, see config.ts): only the recipient
 * and the subject are logged then, never the text, because mails carry single-use links (invitations, password
 * resets) and bid details. Callers must report `false` as "not sent".
 * Throws when delivery fails — callers decide whether that matters.
 */
export function sendMail(mail: Mail): Promise<boolean> {
  return sendMailWith(mail, { isTest: config.isTest, host: config.smtp.host });
}

/** sendMail with the two switches that decide its path passed in (unit tests). */
export async function sendMailWith(mail: Mail, mode: { isTest: boolean; host: string | undefined }): Promise<boolean> {
  if (mode.isTest) {
    testOutbox.push(mail);
    return true;
  }
  if (!mode.host) {
    logger.warn({ to: mail.to, subject: mail.subject }, 'SMTP not configured — mail not sent');
    return false;
  }
  transporter ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass ?? '' } : undefined,
  });
  await transporter.sendMail({ from: config.smtp.from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
  return true;
}
