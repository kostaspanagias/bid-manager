import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage, isApiError } from '@/api/client';
import { PASSWORD_MIN_LENGTH } from '@/features/auth/authApi';
import { useCurrentUser } from '@/features/auth/AuthProvider';
import { enumLabel } from '@/lib/enums';
import { Banner, Button, Card, Field, Input, PageHeader, useToast } from '@/ui';
import { changePassword } from './accountApi';
import './account.css';
import './i18n';

/** /account — the user's own details and password change. */
export function AccountPage() {
  const { t } = useTranslation('account');
  const { user, org } = useCurrentUser();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);

  const save = useMutation({
    mutationFn: () => changePassword(current, next),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setConfirm('');
      setTouched(false);
      toast.success(t('password.done'));
    },
  });

  const errors = {
    current: current ? undefined : t('common:errors.required'),
    next: next.length < PASSWORD_MIN_LENGTH ? t('password.short', { min: PASSWORD_MIN_LENGTH }) : next === current ? t('password.same') : undefined,
    confirm: confirm !== next ? t('password.mismatch') : undefined,
  };
  const code = isApiError(save.error) ? save.error.code : null;
  const serverError = !save.isError ? null : code === 'wrong_current_password' ? null : code === 'password_unchanged' ? t('password.same') : code === 'rate_limited' ? t('password.rateLimited') : errorMessage(save.error);

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <div className="account-grid">
        <Card title={t('profile.title')}>
          <dl className="account-facts">
            <dt>{t('profile.name')}</dt>
            <dd>{user.name}</dd>
            <dt>{t('profile.email')}</dt>
            <dd>{user.email}</dd>
            <dt>{t('profile.role')}</dt>
            <dd>{enumLabel('org_role', user.org_role)}</dd>
            <dt>{t('profile.org')}</dt>
            <dd>{org.name}</dd>
          </dl>
          <p className="account-hint">{t('profile.hint')}</p>
        </Card>

        <Card title={t('password.title')}>
          <form
            className="u-stack"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              setTouched(true);
              save.reset();
              if (!errors.current && !errors.next && !errors.confirm) save.mutate();
            }}
          >
            {serverError && <Banner tone="red">{serverError}</Banner>}
            {/* Lets password managers attach the new password to the right account. */}
            <input type="text" name="username" autoComplete="username" value={user.email} readOnly hidden />
            <Field label={t('password.current')} required error={(touched ? errors.current : undefined) ?? (code === 'wrong_current_password' ? t('password.wrong') : undefined)}>
              <Input type="password" name="current-password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </Field>
            <Field label={t('password.new')} required hint={t('password.newHint', { min: PASSWORD_MIN_LENGTH })} error={touched ? errors.next : undefined}>
              <Input type="password" name="new-password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            </Field>
            <Field label={t('password.confirm')} required error={touched ? errors.confirm : undefined}>
              <Input type="password" name="new-password-confirm" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            <p className="account-hint">{t('password.note')}</p>
            <div>
              <Button type="submit" variant="primary" loading={save.isPending}>
                {t('password.submit')}
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
