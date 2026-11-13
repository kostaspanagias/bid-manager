import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/client';
import { ORG_ROLES, type Invitation, type OrgRole } from '@/api/types';
import { useAuth } from '@/features/auth/AuthProvider';
import { usersKeys } from '@/features/shared/useUsers';
import { enumLabel, enumOptions } from '@/lib/enums';
import {
  Badge,
  Banner,
  Button,
  CellActions,
  Checkbox,
  ConfirmDialog,
  DateText,
  EmptyState,
  Field,
  FilterBar,
  Input,
  Menu,
  Modal,
  PageHeader,
  Select,
  Table,
  Tabs,
  useToast,
  type Column,
  type Tone,
} from '@/ui';
import {
  adminUsersKeys,
  createInvitation,
  deleteInvitation,
  invitationState,
  listAdminUsers,
  listInvitations,
  resetUserPassword,
  resetUserTotp,
  updateAdminUser,
  type AdminUser,
  type CreatedInvitation,
  type InvitationState,
  type PasswordResetLink,
} from './usersApi';
import './admin.css';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** /admin/users — accounts, org roles, invitations (admin only). */
export function UsersPage() {
  const { t } = useTranslation('admin');
  const [tab, setTab] = useState<'users' | 'invitations'>('users');
  const [inviteOpen, setInviteOpen] = useState(false);

  const users = useQuery({ queryKey: adminUsersKeys.users, queryFn: listAdminUsers });
  const invitations = useQuery({ queryKey: adminUsersKeys.invitations, queryFn: listInvitations });
  const pending = (invitations.data ?? []).filter((i) => invitationState(i) === 'pending').length;

  return (
    <>
      <PageHeader
        title={t('users.title')}
        subtitle={t('users.subtitle')}
        actions={
          <Button variant="primary" icon="plus" onClick={() => setInviteOpen(true)}>
            {t('users.invite')}
          </Button>
        }
      />
      <Tabs
        className="admin-tabs"
        label={t('users.title')}
        value={tab}
        onChange={(key) => setTab(key as typeof tab)}
        items={[
          { key: 'users', label: t('users.tabs.users'), count: users.data?.length },
          { key: 'invitations', label: t('users.tabs.invitations'), count: pending || undefined, countTone: 'info' },
        ]}
      />
      {tab === 'users' ? (
        <UsersTable users={users.data} loading={users.isPending} error={users.error} onRetry={() => void users.refetch()} />
      ) : (
        <InvitationsTable
          invitations={invitations.data}
          loading={invitations.isPending}
          error={invitations.error}
          onRetry={() => void invitations.refetch()}
          onInvite={() => setInviteOpen(true)}
        />
      )}
      <InviteModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onCreated={() => setTab('invitations')}
      />
    </>
  );
}

function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <Banner tone="red" title={t('common:errors.loadFailed')} actions={<Button size="sm" onClick={onRetry}>{t('common:actions.retry')}</Button>}>
      {errorMessage(error)}
    </Banner>
  );
}

/* ------------------------------------------------------------------ users */

interface UsersTableProps {
  users: AdminUser[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}

function UsersTable({ users, loading, error, onRetry }: UsersTableProps) {
  const { t } = useTranslation('admin');
  const { user: me } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(true);
  const [roleFor, setRoleFor] = useState<AdminUser | null>(null);
  const [deactivate, setDeactivate] = useState<AdminUser | null>(null);
  const [resetFor, setResetFor] = useState<AdminUser | null>(null);
  const [passwordFor, setPasswordFor] = useState<AdminUser | null>(null);
  const [resetLink, setResetLink] = useState<PasswordResetLink | null>(null);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: adminUsersKeys.users }),
      queryClient.invalidateQueries({ queryKey: usersKeys.all }),
    ]);

  const setActive = useMutation({
    mutationFn: (vars: { user: AdminUser; active: boolean }) => updateAdminUser(vars.user.id, { active: vars.active }),
    onSuccess: async (_data, vars) => {
      await invalidate();
      toast.success(t(vars.active ? 'users.activated' : 'users.deactivated'));
      setDeactivate(null);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const resetTotp = useMutation({
    mutationFn: (user: AdminUser) => resetUserTotp(user.id),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('users.totpReset'));
      setResetFor(null);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const resetPassword = useMutation({
    mutationFn: (user: AdminUser) => resetUserPassword(user),
    onSuccess: async (link) => {
      await invalidate();
      setPasswordFor(null);
      setResetLink(link);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const copyResetLink = async () => {
    if (!resetLink) return;
    try {
      await navigator.clipboard.writeText(resetLink.resetUrl);
      toast.success(t('invitations.linkCopied'));
    } catch {
      toast.error(t('invitations.copyFailed'));
    }
  };

  const rows = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('el');
    return (users ?? [])
      .filter((u) => showInactive || u.active)
      .filter((u) => !q || u.name.toLocaleLowerCase('el').includes(q) || u.email.toLowerCase().includes(q))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'el'));
  }, [users, search, showInactive]);

  const columns: Column<AdminUser>[] = [
    {
      key: 'name',
      header: t('users.columns.name'),
      render: (u) => (
        <>
          <strong>{u.name}</strong>
          {u.id === me?.id && (
            <Badge tone="info" className="admin-you">
              {t('users.you')}
            </Badge>
          )}
        </>
      ),
    },
    { key: 'email', header: t('users.columns.email') },
    { key: 'org_role', header: t('users.columns.role'), render: (u) => enumLabel('org_role', u.org_role) },
    {
      key: 'totp',
      header: t('users.columns.twoFactor'),
      render: (u) =>
        u.totp_enabled ? (
          <Badge tone="green">{t('users.twoFactorOn')}</Badge>
        ) : (
          <Badge tone="orange">{t('users.twoFactorOff')}</Badge>
        ),
    },
    {
      key: 'last_login_at',
      header: t('users.columns.lastLogin'),
      render: (u) => <DateText value={u.last_login_at} withTime fallback={t('users.neverLoggedIn')} />,
    },
    {
      key: 'active',
      header: t('users.columns.status'),
      render: (u) =>
        u.active ? (
          <Badge tone="green" dot>
            {t('common:state.active')}
          </Badge>
        ) : (
          <Badge dot>{t('common:state.inactive')}</Badge>
        ),
    },
    {
      key: 'actions',
      header: t('common:labels.actions'),
      srOnlyHeader: true,
      align: 'right',
      width: 56,
      render: (u) => (
        <CellActions>
          <Menu
            label={u.id === me?.id ? t('users.selfHint') : `${t('common:actions.more')}: ${u.name}`}
            disabled={u.id === me?.id}
            items={[
              { label: t('users.changeRole'), icon: 'edit', onSelect: () => setRoleFor(u) },
              u.active && { label: t('users.resetPassword'), icon: 'lock', onSelect: () => setPasswordFor(u) },
              u.totp_enabled && { label: t('users.resetTotp'), icon: 'shield', onSelect: () => setResetFor(u) },
              u.active
                ? { label: t('users.deactivate'), icon: 'block', danger: true, separatorBefore: true, onSelect: () => setDeactivate(u) }
                : { label: t('users.activate'), icon: 'check', separatorBefore: true, onSelect: () => setActive.mutate({ user: u, active: true }) },
            ]}
          />
        </CellActions>
      ),
    },
  ];

  if (error) return <LoadError error={error} onRetry={onRetry} />;

  return (
    <>
      <FilterBar
        search={{ value: search, onChange: setSearch, placeholder: `${t('users.columns.name')} / ${t('users.columns.email')}` }}
      >
        <Checkbox label={t('users.showInactive')} checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
      </FilterBar>
      <Table
        caption={t('users.title')}
        columns={columns}
        rows={rows}
        loading={loading}
        rowClassName={(u) => (u.active ? undefined : 'is-muted')}
        emptyTitle={search ? t('common:state.emptyFiltered') : t('users.empty')}
      />
      <ChangeRoleModal user={roleFor} onClose={() => setRoleFor(null)} onSaved={invalidate} />
      <ConfirmDialog
        open={resetFor !== null}
        title={t('users.resetTotpTitle')}
        message={resetFor ? t('users.resetTotpMessage', { name: resetFor.name }) : null}
        confirmLabel={t('users.resetTotp')}
        loading={resetTotp.isPending}
        onCancel={() => setResetFor(null)}
        onConfirm={() => resetFor && resetTotp.mutate(resetFor)}
      />
      <ConfirmDialog
        open={passwordFor !== null}
        title={t('users.resetPasswordTitle')}
        message={passwordFor ? t('users.resetPasswordMessage', { name: passwordFor.name, hours: 24 }) : null}
        confirmLabel={t('users.resetPassword')}
        loading={resetPassword.isPending}
        onCancel={() => setPasswordFor(null)}
        onConfirm={() => passwordFor && resetPassword.mutate(passwordFor)}
      />
      <Modal
        open={resetLink !== null}
        onClose={() => setResetLink(null)}
        closeOnBackdrop={false}
        title={t('users.resetPasswordDone')}
        footer={
          <Button variant="primary" onClick={() => setResetLink(null)}>
            {t('common:actions.close')}
          </Button>
        }
      >
        {resetLink && (
          <div className="u-stack">
            <Banner tone={resetLink.emailSent ? 'green' : 'orange'}>
              {t(resetLink.emailSent ? 'users.resetPasswordEmailSent' : 'users.resetPasswordEmailFailed', { email: resetLink.email })}
            </Banner>
            <div className="admin-invite-link">
              <Field label={t('users.resetPasswordLink')}>
                <Input readOnly value={resetLink.resetUrl} onFocus={(e) => e.currentTarget.select()} data-autofocus />
              </Field>
              <Button icon="copy" onClick={copyResetLink}>
                {t('invitations.copyLink')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
      <ConfirmDialog
        open={deactivate !== null}
        danger
        title={t('users.deactivateTitle')}
        message={deactivate ? t('users.deactivateMessage', { name: deactivate.name }) : null}
        confirmLabel={t('users.deactivate')}
        loading={setActive.isPending}
        onCancel={() => setDeactivate(null)}
        onConfirm={() => deactivate && setActive.mutate({ user: deactivate, active: false })}
      />
    </>
  );
}

function RoleSelect({ value, onChange }: { value: OrgRole; onChange: (role: OrgRole) => void }) {
  const { t } = useTranslation('admin');
  return (
    <>
      <Field label={t('invitations.role')} required>
        <Select value={value} onChange={(e) => onChange(e.target.value as OrgRole)} options={enumOptions('org_role', ORG_ROLES)} />
      </Field>
      <p className="admin-role-hint">{t(`common:enums.org_role_hint.${value}`)}</p>
    </>
  );
}

function ChangeRoleModal({ user, onClose, onSaved }: { user: AdminUser | null; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const { t } = useTranslation('admin');
  const toast = useToast();
  const [role, setRole] = useState<OrgRole>('member');
  const [forId, setForId] = useState<string | null>(null);
  if (user && user.id !== forId) {
    setForId(user.id);
    setRole(user.org_role);
  }
  const save = useMutation({
    mutationFn: () => updateAdminUser(user!.id, { org_role: role }),
    onSuccess: async () => {
      await onSaved();
      toast.success(t('users.roleChanged'));
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Modal
      open={user !== null}
      onClose={onClose}
      size="sm"
      title={t('users.changeRoleTitle', { name: user?.name ?? '' })}
      onSubmit={() => save.mutate()}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={role === user?.org_role}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      <RoleSelect value={role} onChange={setRole} />
    </Modal>
  );
}

/* ------------------------------------------------------------ invitations */

const INVITE_TONE: Record<InvitationState, Tone> = { pending: 'info', accepted: 'green', expired: 'neutral' };

interface InvitationsTableProps {
  invitations: Invitation[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onInvite: () => void;
}

function InvitationsTable({ invitations, loading, error, onRetry, onInvite }: InvitationsTableProps) {
  const { t } = useTranslation('admin');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [revoke, setRevoke] = useState<Invitation | null>(null);

  const remove = useMutation({
    mutationFn: (inv: Invitation) => deleteInvitation(inv.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminUsersKeys.invitations });
      toast.success(t('invitations.revoked'));
      setRevoke(null);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const columns: Column<Invitation>[] = [
    { key: 'email', header: t('invitations.columns.email'), render: (i) => <strong>{i.email}</strong> },
    { key: 'org_role', header: t('invitations.columns.role'), render: (i) => enumLabel('org_role', i.org_role) },
    { key: 'created_at', header: t('invitations.columns.created'), render: (i) => <DateText value={i.created_at} withTime /> },
    { key: 'expires_at', header: t('invitations.columns.expires'), render: (i) => <DateText value={i.expires_at} withTime /> },
    {
      key: 'state',
      header: t('invitations.columns.status'),
      render: (i) => {
        const state = invitationState(i);
        return <Badge tone={INVITE_TONE[state]}>{t(`invitations.status.${state}`)}</Badge>;
      },
    },
    {
      key: 'actions',
      header: t('common:labels.actions'),
      srOnlyHeader: true,
      align: 'right',
      render: (i) =>
        i.accepted_at ? null : (
          <CellActions>
            <Button size="sm" variant="danger" onClick={() => setRevoke(i)}>
              {t('invitations.revoke')}
            </Button>
          </CellActions>
        ),
    },
  ];

  if (error) return <LoadError error={error} onRetry={onRetry} />;

  return (
    <>
      <Table
        caption={t('invitations.title')}
        columns={columns}
        rows={invitations}
        loading={loading}
        rowClassName={(i) => (invitationState(i) === 'expired' ? 'is-muted' : undefined)}
        empty={
          <EmptyState
            compact
            title={t('invitations.empty')}
            description={t('invitations.emptyHint')}
            action={
              <Button icon="plus" onClick={onInvite}>
                {t('users.invite')}
              </Button>
            }
          />
        }
      />
      <ConfirmDialog
        open={revoke !== null}
        danger
        title={t('invitations.revokeTitle')}
        message={revoke ? t('invitations.revokeMessage', { email: revoke.email }) : null}
        confirmLabel={t('invitations.revoke')}
        loading={remove.isPending}
        onCancel={() => setRevoke(null)}
        onConfirm={() => revoke && remove.mutate(revoke)}
      />
    </>
  );
}

function InviteModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation('admin');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('member');
  const [touched, setTouched] = useState(false);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);

  const close = () => {
    onClose();
    setEmail('');
    setRole('member');
    setTouched(false);
    setCreated(null);
    create.reset();
  };

  const create = useMutation({
    mutationFn: () => createInvitation({ email: email.trim().toLowerCase(), org_role: role }),
    onSuccess: async (result) => {
      setCreated(result);
      onCreated();
      await queryClient.invalidateQueries({ queryKey: adminUsersKeys.invitations });
    },
  });

  const emailError = !email.trim() ? t('common:errors.required') : !EMAIL_RE.test(email.trim()) ? t('common:errors.invalidEmail') : undefined;

  const copy = async () => {
    if (!created?.inviteUrl) return;
    try {
      await navigator.clipboard.writeText(created.inviteUrl);
      toast.success(t('invitations.linkCopied'));
    } catch {
      toast.error(t('invitations.copyFailed'));
    }
  };

  if (created) {
    return (
      <Modal
        open={open}
        onClose={close}
        closeOnBackdrop={false}
        title={t('invitations.createdTitle')}
        footer={
          <Button variant="primary" onClick={close}>
            {t('common:actions.close')}
          </Button>
        }
      >
        {created.inviteUrl ? (
          <div className="u-stack">
            <Banner tone={created.emailSent === true ? 'green' : 'orange'}>
              {t(
                created.emailSent === true
                  ? 'invitations.emailSent'
                  : created.emailSent === false
                    ? 'invitations.emailFailed'
                    : 'invitations.createdHint',
                { email: created.email },
              )}
            </Banner>
            <div className="admin-invite-link">
              <Field label={t('invitations.link')}>
                <Input readOnly value={created.inviteUrl} onFocus={(e) => e.currentTarget.select()} data-autofocus />
              </Field>
              <Button icon="copy" onClick={copy}>
                {t('invitations.copyLink')}
              </Button>
            </div>
          </div>
        ) : (
          <Banner tone="green">{t('invitations.createdNoLink', { email: created.email })}</Banner>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('invitations.newTitle')}
      onSubmit={() => {
        setTouched(true);
        if (!emailError) create.mutate();
      }}
      footer={
        <>
          <Button onClick={close} disabled={create.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            {t('invitations.create')}
          </Button>
        </>
      }
    >
      <div className="u-stack">
        {create.isError && <Banner tone="red">{errorMessage(create.error)}</Banner>}
        <Field label={t('invitations.email')} required error={touched ? emailError : undefined}>
          <Input type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <div>
          <RoleSelect value={role} onChange={setRole} />
        </div>
      </div>
    </Modal>
  );
}
