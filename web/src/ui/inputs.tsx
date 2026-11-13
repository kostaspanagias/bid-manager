import { useId, type ComponentProps, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { athensLocalToIso, isoToAthensLocal } from '@/lib/dates';
import { useFieldControl } from './Field';

/* All controls take the native element props. Inside <Field> they wire id / aria-describedby / aria-invalid
   automatically; outside a Field give them an aria-label. */

export type InputProps = ComponentProps<'input'>;

/** Text input (also email, password, number, search…). */
export function Input({ className, ...props }: InputProps) {
  const field = useFieldControl(props);
  return <input {...props} {...field} className={cx('ui-input', className)} />;
}

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends ComponentProps<'select'> {
  /** Options as data; alternatively pass <option> children */
  options?: ReadonlyArray<SelectOption>;
  /** Adds a first option with value "" (e.g. «Όλα» in filters, «— Επιλογή —» in forms) */
  placeholder?: string;
}

export function Select({ className, options, placeholder, children, ...props }: SelectProps) {
  const field = useFieldControl(props);
  return (
    <select {...props} {...field} className={cx('ui-input ui-select', className)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options?.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
      {children}
    </select>
  );
}

export type TextareaProps = ComponentProps<'textarea'>;

export function Textarea({ className, rows = 3, ...props }: TextareaProps) {
  const field = useFieldControl(props);
  return <textarea rows={rows} {...props} {...field} className={cx('ui-input ui-textarea', className)} />;
}

export interface CheckboxProps extends Omit<ComponentProps<'input'>, 'type' | 'children'> {
  /** Text next to the box (the checkbox carries its own label — do not wrap in Field) */
  label: ReactNode;
  /** Secondary line under the label */
  hint?: ReactNode;
}

export function Checkbox({ label, hint, className, id, ...props }: CheckboxProps) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <div className={cx('ui-checkbox', props.disabled && 'is-disabled', className)}>
      <input type="checkbox" id={inputId} aria-describedby={hint ? `${inputId}-hint` : undefined} {...props} />
      <div>
        <label htmlFor={inputId}>{label}</label>
        {hint && (
          <p id={`${inputId}-hint`} className="ui-checkbox__hint">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

export interface DateInputProps extends Omit<ComponentProps<'input'>, 'type' | 'value' | 'onChange'> {
  /** 'YYYY-MM-DD' or '' / null */
  value: string | null | undefined;
  /** Receives 'YYYY-MM-DD', or null when cleared */
  onChange: (value: string | null) => void;
}

/** Pure date ('YYYY-MM-DD' in and out). Uses the native date picker. */
export function DateInput({ value, onChange, className, ...props }: DateInputProps) {
  const field = useFieldControl(props);
  return (
    <input
      {...props}
      {...field}
      type="date"
      className={cx('ui-input ui-input--date', className)}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
    />
  );
}

export interface DateTimeInputProps extends Omit<ComponentProps<'input'>, 'type' | 'value' | 'onChange'> {
  /** UTC ISO timestamp or '' / null */
  value: string | null | undefined;
  /** Receives a UTC ISO timestamp, or null when cleared */
  onChange: (value: string | null) => void;
}

/**
 * Date + time. Value in/out is a UTC ISO timestamp; what the user types is Athens wall-clock time
 * regardless of the browser's time zone (spec R3).
 */
export function DateTimeInput({ value, onChange, className, ...props }: DateTimeInputProps) {
  const field = useFieldControl(props);
  return (
    <input
      step={60}
      {...props}
      {...field}
      type="datetime-local"
      className={cx('ui-input ui-input--date', className)}
      value={isoToAthensLocal(value)}
      onChange={(e) => onChange(athensLocalToIso(e.target.value))}
    />
  );
}
