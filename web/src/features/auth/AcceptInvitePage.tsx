import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { errorMessage, isApiError } from '@/api/client';
import { Banner, Button, Field, Input } from '@/ui';
import { authApi, PASSWORD_MIN_LENGTH } from './authApi';
import { AuthLayout } from './AuthLayout';
import type { LoginLocationState } from './LoginPage';

/** /invite/:token — the invited person sets name + password, then logs in and enrols TOTP. */
export function AcceptInvitePage() {
  const { t } = useTranslation('auth');
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);

  const accept = useMutation({
    mutationFn: () => authApi.acceptInvite({ token, name: name.trim(), password }),
    onSuccess: () => {
      const state: LoginLocationState = { notice: 'inviteAccepted' };
      navigate('/login', { replace: true, state });
    },
  });

  const errors = {
    name: !name.trim() ? t('common:errors.required') : undefined,
    password: password.length < PASSWORD_MIN_LENGTH ? t('invite.passwordShort', { min: PASSWORD_MIN_LENGTH }) : undefined,
    confirm: confirm !== password ? t('invite.passwordMismatch') : undefined,
  };
  const valid = !errors.name && !errors.password && !errors.confirm;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (valid) accept.mutate();
  };

  // An unknown / expired / already used token comes back as 404 or 410 (or 422); everything else shows as-is.
  const serverError = !accept.isError
    ? null
    : isApiError(accept.error) && [404, 410, 422].includes(accept.error.status)
      ? t('invite.invalid')
      : errorMessage(accept.error);

  return (
    <AuthLayout
      title={t('invite.title')}
      subtitle={t('invite.subtitle')}
      footer={
        <>
          {t('invite.haveAccount')} <Link to="/login">{t('invite.toLogin')}</Link>
        </>
      }
    >
      <form className="auth__form" onSubmit={submit} noValidate>
        {serverError && <Banner tone="red">{serverError}</Banner>}
        <Field label={t('invite.name')} required error={touched ? errors.name : undefined}>
          <Input name="name" autoComplete="name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label={t('invite.password')}
          required
          hint={t('invite.passwordHint', { min: PASSWORD_MIN_LENGTH })}
          error={touched ? errors.password : undefined}
        >
          <Input
            type="password"
            name="new-password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label={t('invite.passwordConfirm')} required error={touched ? errors.confirm : undefined}>
          <Input
            type="password"
            name="new-password-confirm"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" fullWidth loading={accept.isPending}>
          {t('invite.submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}
