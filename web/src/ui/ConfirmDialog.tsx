import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';
import { Modal } from './Modal';

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  /** What will happen, in one or two sentences */
  message?: ReactNode;
  /** Default «Επιβεβαίωση» */
  confirmLabel?: string;
  /** Default «Άκυρο» */
  cancelLabel?: string;
  /** Red confirm button for destructive actions */
  danger?: boolean;
  /** Spinner on the confirm button while the mutation runs */
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Yes/no confirmation for destructive or irreversible actions. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger,
  loading,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      closeOnBackdrop={!loading}
      footer={
        <>
          <Button onClick={onCancel} disabled={loading}>
            {cancelLabel ?? t('common:actions.cancel')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel ?? t('common:actions.confirm')}
          </Button>
        </>
      }
    >
      {message && <p className="ui-confirm__message">{message}</p>}
    </Modal>
  );
}
