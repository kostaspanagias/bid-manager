// =================================================================================================================
// UNSCOPED QUERIES — the only file outside src/db/ that may import the pg pool (enforced by
// src/test/poolImports.test.ts).
//
// These three lookups run BEFORE an organization is known (the caller only has an e-mail, a session cookie or an
// invitation token), so they cannot go through scopedDb(). Each one only identifies the row and its org_id; all
// further reads and writes are done through scopedDb(row.org_id, …). Do not add queries here for any other reason.
// =================================================================================================================
import { getPool } from '../db/pool.js';
import type { OrgRole } from './types.js';

export interface AuthUserRow {
  id: string;
  org_id: string;
  email: string;
  name: string;
  org_role: OrgRole;
  active: boolean;
  password_hash: string | null;
  totp_secret: string | null;
  totp_enabled_at: Date | null;
  totp_last_step: number | null;
  failed_login_count: number;
  locked_until: Date | null;
}

export interface SessionRow {
  id: string;
  org_id: string;
  user_id: string;
  totp_verified: boolean;
  csrf_token: string;
  totp_attempts: number;
  last_seen_at: Date;
  expires_at: Date;
  created_at: Date;
}

export interface InvitationRow {
  id: string;
  org_id: string;
  email: string;
  org_role: OrgRole;
  expires_at: Date;
  accepted_at: Date | null;
}

const USER_COLUMNS = `u.id, u.org_id, u.email, u.name, u.org_role, u.active, u.password_hash, u.totp_secret,
  u.totp_enabled_at, u.totp_last_step, u.failed_login_count, u.locked_until`;

/** Login: users with this e-mail (normally 0 or 1; e-mail is unique per organization). */
export async function findUsersByEmail(email: string): Promise<AuthUserRow[]> {
  const { rows } = await getPool().query(`SELECT ${USER_COLUMNS} FROM "user" u WHERE u.email = $1 ORDER BY u.created_at LIMIT 5`, [email]);
  return rows as AuthUserRow[];
}

/** Session cookie → session + its user (same org enforced by the join). */
export async function findSessionWithUser(sessionId: string): Promise<{ session: SessionRow; user: AuthUserRow } | null> {
  const { rows } = await getPool().query(
    `SELECT s.id AS s_id, s.org_id AS s_org_id, s.user_id, s.totp_verified, s.csrf_token, s.totp_attempts,
            s.last_seen_at, s.expires_at, s.created_at AS s_created_at, ${USER_COLUMNS}
       FROM session s JOIN "user" u ON u.id = s.user_id AND u.org_id = s.org_id
      WHERE s.id = $1`,
    [sessionId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    session: {
      id: r.s_id,
      org_id: r.s_org_id,
      user_id: r.user_id,
      totp_verified: r.totp_verified,
      csrf_token: r.csrf_token,
      totp_attempts: r.totp_attempts,
      last_seen_at: r.last_seen_at,
      expires_at: r.expires_at,
      created_at: r.s_created_at,
    },
    user: {
      id: r.id,
      org_id: r.org_id,
      email: r.email,
      name: r.name,
      org_role: r.org_role,
      active: r.active,
      password_hash: r.password_hash,
      totp_secret: r.totp_secret,
      totp_enabled_at: r.totp_enabled_at,
      totp_last_step: r.totp_last_step,
      failed_login_count: r.failed_login_count,
      locked_until: r.locked_until,
    },
  };
}

/** Invitation token (hashed) → invitation. */
export async function findInvitationByTokenHash(tokenHash: string): Promise<InvitationRow | null> {
  const { rows } = await getPool().query(
    'SELECT id, org_id, email, org_role, expires_at, accepted_at FROM invitation WHERE token_hash = $1',
    [tokenHash],
  );
  return (rows[0] as InvitationRow | undefined) ?? null;
}
