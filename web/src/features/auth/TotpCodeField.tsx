import { Field, Input } from '@/ui';

export interface TotpCodeFieldProps {
  label: string;
  value: string;
  onChange: (code: string) => void;
  error?: string;
  autoFocus?: boolean;
}

/** 6-digit one-time code input (numeric keypad on phones, password-manager autofill). */
export function TotpCodeField({ label, value, onChange, error, autoFocus }: TotpCodeFieldProps) {
  return (
    <Field label={label} error={error} required>
      <Input
        className="auth__code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      />
    </Field>
  );
}
