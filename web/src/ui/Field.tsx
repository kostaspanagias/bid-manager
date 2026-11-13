import { createContext, useContext, useId, type ReactNode } from 'react';
import { cx } from '@/lib/cx';

interface FieldContextValue {
  id: string;
  describedBy?: string;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export interface FieldProps {
  /** Visible label (always required for accessibility) */
  label: ReactNode;
  /** Help text under the control */
  hint?: ReactNode;
  /** Error message; replaces the hint and marks the control invalid */
  error?: ReactNode;
  /** Shows the required marker and sets aria-required on the control */
  required?: boolean;
  /** Visually hide the label (still read by screen readers) — e.g. in a FilterBar */
  hideLabel?: boolean;
  /** Use when the control is not a kit input and needs a specific id */
  htmlFor?: string;
  className?: string;
  /** One kit control: Input, Select, Textarea, DateInput, DateTimeInput (they pick up id/aria from Field) */
  children: ReactNode;
}

/** Label + control + hint/error. Wrap exactly one control. */
export function Field({ label, hint, error, required = false, hideLabel, htmlFor, className, children }: FieldProps) {
  const auto = useId();
  const id = htmlFor ?? auto;
  const hintId = hint && !error ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={cx('ui-field', error ? 'is-invalid' : undefined, className)}>
      <label className={cx('ui-field__label', hideLabel && 'u-sr-only')} htmlFor={id}>
        {label}
        {required && (
          <span className="ui-field__req" aria-hidden>
            {' '}
            *
          </span>
        )}
      </label>
      <FieldContext.Provider value={{ id, describedBy: errorId ?? hintId, invalid: Boolean(error), required }}>
        {children}
      </FieldContext.Provider>
      {hintId && (
        <p id={hintId} className="ui-field__hint">
          {hint}
        </p>
      )}
      {errorId && (
        <p id={errorId} className="ui-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Used by kit controls to pick up id / aria wiring from the surrounding Field. */
export function useFieldControl(props: { id?: string; 'aria-describedby'?: string; required?: boolean }) {
  const ctx = useContext(FieldContext);
  return {
    id: props.id ?? ctx?.id,
    'aria-describedby': props['aria-describedby'] ?? ctx?.describedBy,
    'aria-invalid': ctx?.invalid || undefined,
    required: props.required ?? (ctx?.required || undefined),
  };
}
