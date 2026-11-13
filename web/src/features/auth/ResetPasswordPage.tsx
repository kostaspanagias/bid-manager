import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { errorMessage, isApiError } from '@/api/client';
import { Banner, Button, Field, Input, LinkButton, PageSpinner } from '@/ui';
import { authApi, PASSWORD_MIN_LENGTH } from './authApi';
import { AuthLayout } from './AuthLayout';
import type { LoginLocationState } from './LoginPage';

/**
 * /reset/:token — the single-use link an admin issues from Χρήστες → «Επαναφορά κωδικού».
 * The user sets a new password and then logs in as usual (the second factor is unchanged).
 */
export function ResetPasswordPage() {
  const { t } = useTranslation('auth');
  const token = useParams().token ?? '';
  const navigate = useNavigate();

  const info = useQuery({
    queryKey: ['auth', 'reset-info', token],
    queryFn: () => authApi.resetInfo(token),
    enabled: Boolean(token),
    retry: false,
    staleTime: Infinity,
  });
  const invalid = !token || (isApiError(info.error) && [400, 404, 410, 422].includes(info.error.status));
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);

  const save = useMutation({
    mutationFn: () => authApi.resetPassword({ token, password }),
    onSuccess: ({ email }) => {
      const state: LoginLocationState = { notice: 'passwordReset', email: email ?? info.data?.email };
      navigate('/login', { replace: true, state });
    },
  });

  const errors = {
    password: password.length < PASSWORD_MIN_LENGTH ? t('invite.passwordShort', { min: PASSWORD_MIN_LENGTH }) : undefined,
    confirm: confirm !== password ? t('invite.passwordMismatch') : undefined,
  };
  const valid = !errors.password && !errors.confirm;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (valid) save.mutate();
  };

  const serverError = !save.isError
    ? null
    : isApiError(save.error) && [404, 410, 422].includes(save.error.status)
      ? t('reset.invalid')
      : errorMessage(save.error);

  if (invalid) {
    return (
      <AuthLayout title={t('reset.invalidTitle')}>
        <div className="auth__form">
          <Banner tone="red">{t('reset.invalid')}</Banner>
          <LinkButton to="/login">{t('reset.toLogin')}</LinkButton>
        </div>
      </AuthLayout>
    );
  }
  if (info.isPending) return <PageSpinner label={t('reset.checking')} />;

  return (
    <AuthLayout title={t('reset.title')} subtitle={t('reset.subtitle')} footer={<Link to="/login">{t('reset.toLogin')}</Link>}>
      <form className="auth__form" onSubmit={submit} noValidate>
        {info.data && (
          <Banner tone="info" title={t('reset.for', { email: info.data.email })}>
            {t('reset.forOrg', { org: info.data.org_name })}
          </Banner>
        )}
        {serverError && <Banner tone="red">{serverError}</Banner>}
        <Field
          label={t('reset.password')}
          required
          hint={t('invite.passwordHint', { min: PASSWORD_MIN_LENGTH })}
          error={touched ? errors.password : undefined}
        >
          <Input
            type="password"
            name="new-password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label={t('reset.passwordConfirm')} required error={touched ? errors.confirm : undefined}>
          <Input
            type="password"
            name="new-password-confirm"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" fullWidth loading={save.isPending}>
          {t('reset.submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}
