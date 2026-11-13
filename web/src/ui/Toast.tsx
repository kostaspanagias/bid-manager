import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cx } from '@/lib/cx';
import { Icon, type IconName } from './icons';

type ToastTone = 'green' | 'red' | 'info';

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: ReactNode;
}

export interface ToastApi {
  /** Confirmation of a completed action («Αποθηκεύτηκε») */
  success: (message: ReactNode) => void;
  /** Failure; stays longer. Use errorMessage(err) from api/client for thrown errors. */
  error: (message: ReactNode) => void;
  info: (message: ReactNode) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const ICONS: Record<ToastTone, IconName> = { green: 'checkCircle', red: 'block', info: 'info' };

/** Mount once near the root (done in App.tsx). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((list) => list.filter((i) => i.id !== id)), []);

  const push = useCallback(
    (tone: ToastTone, message: ReactNode) => {
      const id = nextId.current++;
      setItems((list) => [...list.slice(-3), { id, tone, message }]);
      window.setTimeout(() => dismiss(id), tone === 'red' ? 9000 : 4500);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push('green', m),
      error: (m) => push('red', m),
      info: (m) => push('info', m),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="ui-toasts" role="region" aria-live="polite" aria-relevant="additions">
          {items.map((item) => (
            <div key={item.id} className={cx('ui-toast', `ui-tone-${item.tone}`)} role={item.tone === 'red' ? 'alert' : 'status'}>
              <Icon name={ICONS[item.tone]} size={18} className="ui-toast__icon" />
              <div className="ui-toast__msg">{item.message}</div>
              <button type="button" className="ui-toast__close" onClick={() => dismiss(item.id)} aria-label={t('common:actions.close')}>
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

/** const toast = useToast(); toast.success(t('common:state.saved')); toast.error(errorMessage(err)); */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
