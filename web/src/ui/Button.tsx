import type { ComponentProps, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { cx } from '@/lib/cx';
import { Icon, type IconName } from './icons';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

interface ButtonStyleProps {
  /** primary = the one main action of a view; secondary (default); ghost = low emphasis; danger = destructive */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon */
  icon?: IconName;
  /** Icon-only button: children become the accessible label */
  iconOnly?: boolean;
  fullWidth?: boolean;
}

export interface ButtonProps extends ButtonStyleProps, Omit<ComponentProps<'button'>, 'children'> {
  /** Shows a spinner and disables the button (keeps its width) */
  loading?: boolean;
  children?: ReactNode;
}

function classes({ variant = 'secondary', size = 'md', iconOnly, fullWidth }: ButtonStyleProps, extra?: string) {
  return cx(
    'ui-btn',
    `ui-btn--${variant}`,
    size === 'sm' && 'ui-btn--sm',
    iconOnly && 'ui-btn--icon',
    fullWidth && 'ui-btn--block',
    extra,
  );
}

function content(icon: IconName | undefined, iconOnly: boolean | undefined, children: ReactNode) {
  return (
    <>
      {icon && <Icon name={icon} />}
      {iconOnly ? <span className="u-sr-only">{children}</span> : <span className="ui-btn__label">{children}</span>}
    </>
  );
}

/** Button. `type` defaults to "button" — pass type="submit" inside forms. */
export function Button({
  variant,
  size,
  icon,
  iconOnly,
  fullWidth,
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(classes({ variant, size, iconOnly, fullWidth }, className), loading && 'is-loading')}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      title={iconOnly && typeof children === 'string' ? children : rest.title}
      {...rest}
    >
      {loading && <span className="ui-spinner ui-btn__spinner" aria-hidden />}
      {content(icon, iconOnly, children)}
    </button>
  );
}

export interface LinkButtonProps extends ButtonStyleProps, Omit<LinkProps, 'children'> {
  children?: ReactNode;
}

/** A router link that looks like a button (e.g. «Νέος διαγωνισμός»). */
export function LinkButton({ variant, size, icon, iconOnly, fullWidth, className, children, ...rest }: LinkButtonProps) {
  return (
    <Link className={classes({ variant, size, iconOnly, fullWidth }, className)} {...rest}>
      {content(icon, iconOnly, children)}
    </Link>
  );
}
