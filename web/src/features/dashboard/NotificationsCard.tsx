import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/client';
import { useAuth } from '@/features/auth/AuthProvider';
import { Badge, Button, Card, Checkbox, Modal, Spinner, useToast } from '@/ui';
import { dashboardKeys, fetchPrefs, previewDigest, runDigest, savePrefs, type NotificationPrefs } from './dashboardApi';

/** Notification preferences of the signed-in user, a preview of today's digest, and "run now" for admins. */
export function NotificationsCard() {
  const { t } = useTranslation('dashboard');
  const toast = useToast();
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();
  const [previewOpen, setPreviewOpen] = useState(false);

  const prefs = useQuery({ queryKey: dashboardKeys.prefs, queryFn: fetchPrefs });
  const save = useMutation({
    mutationFn: savePrefs,
    onSuccess: (data) => {
      queryClient.setQueryData<NotificationPrefs>(dashboardKeys.prefs, data);
      toast.success(t('common:state.saved'));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const preview = useMutation({ mutationFn: previewDigest, onError: (err) => toast.error(errorMessage(err)) });
  const run = useMutation({
    mutationFn: runDigest,
    onSuccess: (r) => {
      const sent = r.detail?.sent ?? 0;
      if (r.status === 'failed') toast.error(t('notifications.runFailed'));
      else if (r.alreadyRan) toast.info(t('notifications.runAlready', { sent }));
      else toast.success(t('notifications.runDone', { sent }));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const openPreview = () => {
    setPreviewOpen(true);
    preview.mutate();
  };
  const p = preview.data;

  return (
    <Card title={t('notifications.title')} subtitle={prefs.data ? t('notifications.subtitle', { email: prefs.data.email }) : undefined}>
      {prefs.isPending ? (
        <Spinner />
      ) : prefs.isError ? (
        <p className="u-text-red">{errorMessage(prefs.error)}</p>
      ) : (
        <div className="u-stack">
          <Checkbox
            label={t('notifications.digest')}
            hint={t('notifications.digestHint')}
            checked={prefs.data.digest}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ digest: e.target.checked })}
          />
          <Checkbox
            label={t('notifications.immediate')}
            hint={t('notifications.immediateHint')}
            checked={prefs.data.immediate}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ immediate: e.target.checked })}
          />
          <div className="u-row">
            <Button onClick={openPreview} icon="search">
              {t('notifications.preview')}
            </Button>
            {isAdmin && (
              <Button variant="ghost" loading={run.isPending} onClick={() => run.mutate()} title={t('notifications.runHint')}>
                {t('notifications.run')}
              </Button>
            )}
          </div>
        </div>
      )}

      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={t('notifications.previewTitle')}
        description={t('notifications.previewNote')}
        size="lg"
        footer={<Button onClick={() => setPreviewOpen(false)}>{t('common:actions.close')}</Button>}
      >
        {preview.isPending || !p ? (
          preview.isError ? (
            <p className="u-text-red">{errorMessage(preview.error)}</p>
          ) : (
            <Spinner />
          )
        ) : (
          <div className="u-stack">
            <p className="u-row">
              <Badge tone={p.wouldSend ? 'green' : 'neutral'} dot>
                {p.wouldSend ? t('notifications.wouldSend') : t('notifications.wouldNotSend')}
              </Badge>
              {p.reason && <span className="u-muted">{t(`notifications.reason.${p.reason}`)}</span>}
            </p>
            {(p.wouldSend || p.reason === 'already_sent' || p.reason === 'opted_out' || p.reason === 'quiet_day') && (
              <div className="dash-mail">
                <p className="dash-mail__subject">
                  <span className="u-muted">{t('notifications.subject')}: </span>
                  {p.subject}
                </p>
                <pre className="dash-mail__body">{p.text}</pre>
              </div>
            )}
          </div>
        )}
      </Modal>
    </Card>
  );
}
