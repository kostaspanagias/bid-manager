import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation } from 'react-router-dom';
import { errorMessage, isApiError } from '@/api/client';
import { Banner, Button, Field, Input, PageSpinner, useToast } from '@/ui';
import { authApi, type LoginNext } from './authApi';
import { AuthLayout } from './AuthLayout';
import { useAuth } from './AuthProvider';
import { TotpCodeField } from './TotpCodeField';

type Step = 'credentials' | LoginNext;

export interface LoginLocationState {
  /** Where to go after login */
  from?: string;
  /** Why the login screen is shown */
  notice?: 'expired' | 'loggedOut' | 'inviteAccepted';
  /** Prefill (after accepting an invitation) */
  email?: string;
}

/** /login — email + password, then TOTP code or first-time TOTP enrolment. */
export function LoginPage() {
  const { t } = useTranslation('auth');
  const auth = useAuth();
  const location = useLocation();
  const state = (location.state ?? {}) as LoginLocationState;
  const [chosen, setChosen] = useState<Step | null>(null);
  const [ended, setEnded] = useState(false);

  if (auth.status === 'loading') return <PageSpinner label={t('checking')} />;
  if (auth.user) return <Navigate to={state.from && state.from !== '/login' ? state.from : '/'} replace />;

  // A reload in the middle of the login resumes at the open second step.
  const step: Step = chosen ?? auth.pendingStep ?? 'credentials';
  const notice = auth.sessionExpired ? 'expired' : state.notice;
  /** Back to e-mail + password; drops the half-open session. `sessionEnded` = the server already dropped it. */
  const restart = (sessionEnded = false) => {
    setEnded(sessionEnded);
    setChosen('credentials');
    void auth.logout().catch(() => undefined);
  };

  if (step === 'totp') return <TotpStep onRestart={restart} />;
  if (step === 'totp_setup') return <TotpSetupStep onRestart={restart} />;

  return (
    <AuthLayout title={t('login.title')} subtitle={t('login.subtitle')} footer={t('login.noSignup')}>
      {ended && (
        <Banner tone="orange" className="auth__notice">
          {t('totp.sessionEnded')}
        </Banner>
      )}
      {notice && !ended && (
        <Banner tone={notice === 'expired' ? 'orange' : notice === 'inviteAccepted' ? 'green' : 'info'} className="auth__notice">
          {t(`login.${notice}`)}
        </Banner>
      )}
      <CredentialsForm
        initialEmail={state.email ?? ''}
        spaced={Boolean(notice) || ended}
        onNext={(next) => {
          setEnded(false);
          setChosen(next);
        }}
      />
    </AuthLayout>
  );
}

function loginError(err: unknown, t: (key: string) => string): string {
  if (isApiError(err)) {
    if (err.status === 401 || err.code === 'validation_error') return t('login.invalid');
    if (err.status === 429) return t('login.rateLimited');
  }
  return errorMessage(err);
}

/** The half-open session is gone (timed out, too many wrong codes): the login has to start over. */
function loginSessionEnded(err: unknown): boolean {
  return isApiError(err) && ((err.status === 401 && err.code !== 'invalid_code') || err.status === 409);
}

function CredentialsForm({ onNext, spaced, initialEmail }: { onNext: (next: LoginNext) => void; spaced: boolean; initialEmail: string }) {
  const { t } = useTranslation('auth');
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const login = useMutation({
    mutationFn: () => authApi.login(email.trim(), password),
    onSuccess: onNext,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!email.trim() || !password) return;
    login.mutate();
  };

  return (
    <form className="auth__form" onSubmit={submit} noValidate style={spaced ? { marginTop: 'var(--sp-4)' } : undefined}>
      {login.isError && <Banner tone="red">{loginError(login.error, t)}</Banner>}
      <Field label={t('login.email')} required error={touched && !email.trim() ? t('common:errors.required') : undefined}>
        <Input
          type="email"
          name="email"
          autoComplete="username"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field label={t('login.password')} required error={touched && !password ? t('common:errors.required') : undefined}>
        <Input
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="primary" fullWidth loading={login.isPending}>
        {t('login.submit')}
      </Button>
    </form>
  );
}

function totpError(err: unknown, t: (key: string) => string): string {
  if (isApiError(err)) {
    if (err.code === 'invalid_code' || err.code === 'validation_error' || err.status === 422) return t('totp.invalid');
    if (err.status === 429) return t('login.rateLimited');
  }
  return errorMessage(err);
}

/** Second step for users who already have TOTP. */
function TotpStep({ onRestart }: { onRestart: (sessionEnded?: boolean) => void }) {
  const { t } = useTranslation('auth');
  const auth = useAuth();
  const [code, setCode] = useState('');
  const verify = useMutation({
    mutationFn: async (value: string) => {
      await authApi.verifyTotp(value);
      await auth.refresh(); // sets the user → LoginPage redirects
    },
    onError: (err) => {
      setCode('');
      if (loginSessionEnded(err)) onRestart(true);
    },
  });

  const change = (value: string) => {
    setCode(value);
    if (value.length === 6 && !verify.isPending) verify.mutate(value);
  };

  return (
    <AuthLayout title={t('totp.title')} subtitle={t('totp.subtitle')} eyebrow={t('totp.step')}>
      <form
        className="auth__form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (code.length === 6) verify.mutate(code);
        }}
      >
        <TotpCodeField
          label={t('totp.code')}
          value={code}
          onChange={change}
          error={verify.isError ? totpError(verify.error, t) : undefined}
          autoFocus
        />
        <Button type="submit" variant="primary" fullWidth loading={verify.isPending} disabled={code.length !== 6}>
          {t('totp.submit')}
        </Button>
        <button type="button" className="auth__link-btn" onClick={() => onRestart()}>
          {t('totp.back')}
        </button>
      </form>
    </AuthLayout>
  );
}

/** Second step for users without TOTP yet: show QR + secret, confirm with a code. */
function TotpSetupStep({ onRestart }: { onRestart: (sessionEnded?: boolean) => void }) {
  const { t } = useTranslation('auth');
  const auth = useAuth();
  const toast = useToast();
  const [code, setCode] = useState('');
  const setup = useQuery({
    queryKey: ['auth', 'totp-setup'],
    queryFn: authApi.getTotpSetup,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const enable = useMutation({
    mutationFn: async () => {
      await authApi.enableTotp(code);
      await auth.refresh();
    },
    onError: (err) => {
      setCode('');
      if (loginSessionEnded(err)) onRestart(true);
    },
  });

  const copySecret = async () => {
    if (!setup.data) return;
    try {
      await navigator.clipboard.writeText(setup.data.secret);
      toast.success(t('common:actions.copied'));
    } catch {
      /* the secret is selectable; nothing else to do */
    }
  };

  return (
    <AuthLayout title={t('setup.title')} subtitle={t('setup.subtitle')} eyebrow={t('totp.step')}>
      {setup.isPending && <PageSpinner />}
      {setup.isError && (
        <div className="auth__form">
          <Banner tone="red">{t('setup.loadFailed')}</Banner>
          <Button onClick={() => onRestart()}>{t('totp.back')}</Button>
        </div>
      )}
      {setup.data && (
        <form
          className="auth__form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (code.length === 6) enable.mutate();
          }}
        >
          <ol className="auth__steps">
            <li>
              {t('setup.step1')}
              <img className="auth__qr" src={setup.data.qrDataUrl} alt={t('setup.qrAlt')} width={176} height={176} />
            </li>
            <li>
              {t('setup.step2')}
              <div className="auth__secret">
                <code aria-label={t('setup.secret')}>{setup.data.secret}</code>
                <Button size="sm" iconOnly icon="copy" onClick={copySecret}>
                  {t('setup.copySecret')}
                </Button>
              </div>
            </li>
            <li>{t('setup.step3')}</li>
          </ol>
          <TotpCodeField
            label={t('totp.code')}
            value={code}
            onChange={setCode}
            error={enable.isError ? totpError(enable.error, t) : undefined}
          />
          <Button type="submit" variant="primary" icon="shield" fullWidth loading={enable.isPending} disabled={code.length !== 6}>
            {t('setup.submit')}
          </Button>
          <button type="button" className="auth__link-btn" onClick={() => onRestart()}>
            {t('totp.back')}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
