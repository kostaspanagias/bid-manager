import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cx } from '@/lib/cx';
import { Icon } from './icons';

export interface ModalProps {
  open: boolean;
  /** Called on Esc, backdrop click and the close button */
  onClose: () => void;
  title: ReactNode;
  /** Optional line under the title */
  description?: ReactNode;
  /** Body */
  children?: ReactNode;
  /** Footer buttons (right-aligned; stacked on phones). Put the primary action last. */
  footer?: ReactNode;
  /** sm 420px, md 560px (default), lg 820px. Full-width sheet on phones. */
  size?: 'sm' | 'md' | 'lg';
  /** Set false while a form inside is dirty/saving to avoid accidental loss. Default true. */
  closeOnBackdrop?: boolean;
  /** Wrap body+footer in a <form>; Enter submits */
  onSubmit?: () => void;
  className?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let openCount = 0;

/**
 * Modal dialog: focus is moved in and trapped, Esc closes, focus returns to the opener.
 * Renders nothing when `open` is false, so state inside resets on each open.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  closeOnBackdrop = true,
  onSubmit,
  className,
}: ModalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    openCount++;
    document.body.classList.add('ui-modal-open');

    // Focus the first field (or first focusable control in the body), else the dialog itself.
    const preferred =
      dialog?.querySelector<HTMLElement>('[data-autofocus]') ??
      dialog?.querySelector<HTMLElement>('.ui-modal__body input, .ui-modal__body select, .ui-modal__body textarea') ??
      dialog?.querySelector<HTMLElement>('.ui-modal__footer button:last-child');
    (preferred ?? dialog)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (!dialog) return;
      // Only the top-most modal reacts.
      const all = document.querySelectorAll('.ui-modal');
      if (all[all.length - 1] !== dialog) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
      if (nodes.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (!dialog.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      openCount--;
      if (openCount === 0) document.body.classList.remove('ui-modal-open');
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open]);

  if (!open) return null;

  const inner = (
    <>
      <div className="ui-modal__body">{children}</div>
      {footer && <div className="ui-modal__footer">{footer}</div>}
    </>
  );

  return createPortal(
    <div
      className="ui-modal-backdrop"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={cx('ui-modal', `ui-modal--${size}`, className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
      >
        <header className="ui-modal__header">
          <div>
            <h2 id={titleId} className="ui-modal__title">
              {title}
            </h2>
            {description && (
              <p id={descId} className="ui-modal__desc">
                {description}
              </p>
            )}
          </div>
          <button type="button" className="ui-modal__close" onClick={onClose} aria-label={t('common:actions.close')}>
            <Icon name="close" />
          </button>
        </header>
        {onSubmit ? (
          <form
            className="ui-modal__form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            {inner}
          </form>
        ) : (
          inner
        )}
      </div>
    </div>,
    document.body,
  );
}
