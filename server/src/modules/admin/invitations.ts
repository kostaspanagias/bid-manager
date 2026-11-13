// Mounted at /api/admin/invitations — admin only. There is no public sign-up: this is how users are created.
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { randomToken, sha256Hex } from '../../core/crypto.js';
import { conflict, notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { sendMail } from '../../core/mailer.js';
import { requireRole } from '../../core/permissions.js';
import { ORG_ROLES } from '../../core/types.js';
import type { Row } from '../../db/scoped.js';

export const router: Router = Router();
router.use(requireRole('admin'));

export const INVITATION_DAYS = 7;

const createBody = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
    org_role: z.enum(ORG_ROLES).default('member'),
  })
  .strict();

/** Never exposes token_hash. */
function view(i: Row) {
  const status = i.accepted_at ? 'accepted' : new Date(i.expires_at).getTime() <= Date.now() ? 'expired' : 'pending';
  return { id: i.id, email: i.email, org_role: i.org_role, status, expires_at: i.expires_at, accepted_at: i.accepted_at, created_at: i.created_at };
}

router.get('/', async (req, res) => {
  const rows = await req.ctx.db.list('invitation', {}, { orderBy: 'created_at desc' });
  res.json({ items: rows.map(view) });
});

router.post('/', async (req, res) => {
  const body = createBody.parse(req.body);
  const { ctx } = req;
  const token = randomToken(32);
  const invitation = await ctx.db.tx(async (db) => {
    if (await db.findOne('user', { email: body.email })) throw conflict('A user with this e-mail already exists', undefined, 'user_exists');
    // A new invitation replaces any pending one for the same address (the old link stops working).
    for (const old of await db.list('invitation', { email: body.email, accepted_at: null })) await db.remove('invitation', old.id);
    return db.insert('invitation', {
      email: body.email,
      org_role: body.org_role,
      token_hash: sha256Hex(token),
      expires_at: new Date(Date.now() + INVITATION_DAYS * 86_400_000),
    });
  });
  const acceptUrl = `${config.appUrl}/accept-invite?token=${encodeURIComponent(token)}`;
  let emailSent = true;
  try {
    await sendMail({
      to: body.email,
      subject: 'Πρόσκληση στο Bid Manager',
      text: [
        `Ο/Η ${ctx.user.name} σας προσκάλεσε στο Bid Manager.`,
        '',
        `Ορίστε όνομα και κωδικό εδώ (ο σύνδεσμος ισχύει ${INVITATION_DAYS} ημέρες):`,
        acceptUrl,
        '',
        'Στην πρώτη είσοδο θα ρυθμίσετε έλεγχο ταυτότητας δύο παραγόντων (εφαρμογή authenticator).',
      ].join('\n'),
    });
  } catch (err) {
    emailSent = false;
    logger.error({ err }, 'invitation e-mail failed');
  }
  // The token is returned exactly once (only its hash is stored) so the admin can also pass the link on by hand.
  res.status(201).json({ invitation: view(invitation), token, acceptUrl, emailSent });
});

router.delete('/:id', async (req, res) => {
  const invitation = await req.ctx.db.get('invitation', String(req.params.id));
  if (!invitation) throw notFound('Invitation not found');
  if (invitation.accepted_at) throw conflict('The invitation has already been accepted', undefined, 'invitation_accepted');
  await req.ctx.db.remove('invitation', invitation.id);
  res.status(204).end();
});
