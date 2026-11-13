import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/client';
import type { ID } from '@/api/types';
import { UserSelect } from '@/features/shared/UserSelect';
import { useUsers } from '@/features/shared/useUsers';
import { useTender } from '@/features/tenders/tenderContext';
import { enumLabel } from '@/lib/enums';
import { Badge, Banner, Button, Card, Field, PageHeader, PageSpinner, useToast } from '@/ui';
import { fetchTeam, saveTeam, tenderKeys, type MemberInput, type TenderMemberRow, type TenderRoleInfo } from './tenderApi';
import './tenders.css';

interface Group {
  key: string | null;
  name: string;
  role: TenderRoleInfo | null;
  members: TenderMemberRow[];
}

/** Team: who holds which tender role (roles come from the template). One person may hold several roles. */
export function TeamTab() {
  const { t } = useTranslation('tenders');
  const { tenderId, canWrite, canManage, refetch } = useTender();
  const canEdit = canWrite && canManage;
  const toast = useToast();
  const queryClient = useQueryClient();
  const { users } = useUsers();

  const query = useQuery({ queryKey: tenderKeys.members(tenderId), queryFn: () => fetchTeam(tenderId) });
  const save = useMutation({
    mutationFn: (members: MemberInput[]) => saveTeam(tenderId, members),
    onSuccess: async (data) => {
      queryClient.setQueryData(tenderKeys.members(tenderId), data);
      // gate approvers and "my work" follow the roles
      await queryClient.invalidateQueries({ queryKey: tenderKeys.detail(tenderId), predicate: (q) => q.queryKey[2] !== 'members' });
      await refetch();
      toast.success(t('common:state.saved'));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (query.isPending) return <PageSpinner />;
  if (query.isError) {
    return (
      <Banner
        tone="red"
        title={t('common:errors.loadFailed')}
        actions={
          <Button size="sm" onClick={() => void query.refetch()}>
            {t('common:actions.retry')}
          </Button>
        }
      >
        {errorMessage(query.error)}
      </Banner>
    );
  }

  const { roles, items } = query.data;
  const current: MemberInput[] = items.map((m) => ({ user_id: m.user_id, role_key: m.tender_role_key }));
  const add = (userId: ID, roleKey: string | null) => save.mutate([...current, { user_id: userId, role_key: roleKey }]);
  const remove = (m: TenderMemberRow) => save.mutate(current.filter((c) => !(c.user_id === m.user_id && c.role_key === m.tender_role_key)));

  const groups: Group[] = [
    ...roles.map((role) => ({ key: role.key, name: role.name, role, members: items.filter((m) => m.tender_role_key === role.key) })),
    { key: null, name: t('team.plain.title'), role: null, members: items.filter((m) => m.tender_role_key === null) },
  ];
  const unstaffed = roles.filter((r) => !items.some((m) => m.tender_role_key === r.key));

  return (
    <>
      <PageHeader level={2} title={t('team.title')} subtitle={t('team.subtitle')} />
      {unstaffed.length > 0 && (
        <Banner tone="orange" title={t('team.unstaffed.title', { count: unstaffed.length })} className="team-banner">
          {t('team.unstaffed.body', { roles: unstaffed.map((r) => r.name).join(' · ') })}
        </Banner>
      )}
      <div className="team-grid">
        {groups.map((group) => {
          const taken = new Set(group.members.map((m) => m.user_id));
          const candidates = users.filter((u) => !taken.has(u.id));
          return (
            <Card
              key={group.key ?? '_plain'}
              title={group.name}
              subtitle={group.role ? (group.role.payload.deliverables ?? undefined) : t('team.plain.subtitle')}
              actions={
                group.role && (
                  <span className="u-row">
                    {group.role.payload.financial && <Badge tone="orange">{t('team.financial')}</Badge>}
                    {group.role.payload.management && <Badge tone="info">{t('team.management')}</Badge>}
                    {group.role.payload.folder && <Badge tone="neutral">{enumLabel('folder', group.role.payload.folder)}</Badge>}
                  </span>
                )
              }
            >
              {group.members.length === 0 ? (
                <p className="u-muted team-empty">{group.role ? t('team.noHolder') : t('team.plain.empty')}</p>
              ) : (
                <ul className="team-list">
                  {group.members.map((m) => (
                    <li key={m.id}>
                      <div className="team-list__who">
                        <strong>{m.user.name}</strong>
                        <span className="u-muted u-truncate">{m.user.email}</span>
                      </div>
                      <Badge tone="neutral">{enumLabel('org_role', m.user.org_role)}</Badge>
                      {!m.user.active && <Badge tone="red">{t('common:state.inactive')}</Badge>}
                      {canEdit && (
                        <Button size="sm" variant="ghost" icon="close" iconOnly disabled={save.isPending} onClick={() => remove(m)}>
                          {t('team.remove', { name: m.user.name, role: group.name })}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {canEdit && (
                <Field label={t('team.add', { role: group.name })} hideLabel className="team-add">
                  <UserSelect
                    value={null}
                    users={candidates}
                    emptyLabel={t('team.addPlaceholder')}
                    disabled={save.isPending || candidates.length === 0}
                    onChange={(userId) => userId && add(userId, group.key)}
                  />
                </Field>
              )}
            </Card>
          );
        })}
      </div>
      {!canEdit && <p className="u-muted team-note">{t('team.readOnly')}</p>}
    </>
  );
}
