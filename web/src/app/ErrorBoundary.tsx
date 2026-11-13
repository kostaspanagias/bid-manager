import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { Button, EmptyState } from '@/ui';
import { NotFoundPage } from './NotFoundPage';

function ErrorFallback({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  const detail = error instanceof Error ? error.message : undefined;
  return (
    <div role="alert">
      <EmptyState
        icon="alert"
        title={t('common:errors.boundaryTitle')}
        description={
          <>
            {t('common:errors.boundaryDescription')}
            {detail && import.meta.env.DEV && (
              <>
                <br />
                <code>{detail}</code>
              </>
            )}
          </>
        }
        action={
          <div className="u-row" style={{ justifyContent: 'center' }}>
            {onRetry && <Button onClick={onRetry}>{t('common:actions.retry')}</Button>}
            <Button variant="primary" onClick={() => window.location.reload()}>
              {t('common:errors.reload')}
            </Button>
          </div>
        }
      />
    </div>
  );
}

interface Props {
  children: ReactNode;
  /** Change to reset the boundary (e.g. the current pathname) */
  resetKey?: string;
}

interface State {
  error: unknown;
  resetKey?: string;
}

/** Catches render errors of a subtree so the shell (navigation) stays usable. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey };
    return null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('UI error boundary:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return <ErrorFallback error={this.state.error} onRetry={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}

/** errorElement of the router: 404 responses and anything thrown outside the in-shell boundary. */
export function RouteError() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage standalone />;
  return (
    <div style={{ padding: 'var(--sp-8) var(--sp-4)' }}>
      <ErrorFallback error={error} />
    </div>
  );
}
