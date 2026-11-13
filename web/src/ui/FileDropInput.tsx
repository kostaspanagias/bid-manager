import { useId, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { cx } from '@/lib/cx';
import { Icon } from './icons';

export interface FileDropInputProps {
  /** Called with the accepted files (already filtered by size/type) */
  onFiles: (files: File[]) => void;
  /** Called with a Greek message for every rejected file (too large / wrong type) — show it in a toast */
  onReject?: (message: string) => void;
  /** Controlled list of chosen files to display under the zone (optional) */
  files?: ReadonlyArray<File>;
  /** With `files`: called when the user removes one from the list */
  onRemove?: (index: number) => void;
  /** Native accept string, e.g. '.csv,.xlsx' or 'application/pdf' */
  accept?: string;
  multiple?: boolean;
  /** Per-file limit in MB. Default 200 (spec: file size limit). */
  maxSizeMb?: number;
  /** Accessible name of the file input. Default: the visible prompt. */
  label?: string;
  /** Extra line under the prompt (e.g. allowed formats) */
  hint?: string;
  disabled?: boolean;
  className?: string;
}

function matchesAccept(file: File, accept: string | undefined): boolean {
  if (!accept) return true;
  const name = file.name.toLowerCase();
  return accept
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => {
      if (rule.startsWith('.')) return name.endsWith(rule);
      if (rule.endsWith('/*')) return file.type.startsWith(rule.slice(0, -1));
      return file.type === rule;
    });
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Drag-and-drop zone with a regular file input inside (keyboard and screen-reader friendly). */
export function FileDropInput({
  onFiles,
  onReject,
  files,
  onRemove,
  accept,
  multiple,
  maxSizeMb = 200,
  label,
  hint,
  disabled,
  className,
}: FileDropInputProps) {
  const { t } = useTranslation();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const handle = (incoming: FileList | null) => {
    if (!incoming || disabled) return;
    const accepted: File[] = [];
    for (const file of Array.from(incoming)) {
      if (!matchesAccept(file, accept)) {
        onReject?.(t('common:file.badType', { name: file.name }));
      } else if (file.size > maxSizeMb * 1024 * 1024) {
        onReject?.(t('common:file.tooLarge', { name: file.name, mb: maxSizeMb }));
      } else {
        accepted.push(file);
      }
    }
    const result = multiple ? accepted : accepted.slice(0, 1);
    if (result.length) onFiles(result);
    if (inputRef.current) inputRef.current.value = '';
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    handle(e.dataTransfer.files);
  };

  return (
    <div className={cx('ui-filedrop', className)}>
      <label
        htmlFor={inputId}
        className={cx('ui-filedrop__zone', over && 'is-over', disabled && 'is-disabled')}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          className="ui-filedrop__input"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          aria-label={label}
          onChange={(e) => handle(e.target.files)}
        />
        <Icon name="upload" size={20} />
        <span className="ui-filedrop__prompt">
          {t('common:file.drop')} <span className="ui-filedrop__browse">{t('common:file.browse')}</span>
        </span>
        <span className="ui-filedrop__hint">
          {hint ? `${hint} · ` : ''}
          {t('common:file.maxSize', { mb: maxSizeMb })}
        </span>
      </label>
      {files && files.length > 0 && (
        <ul className="ui-filedrop__list">
          {files.map((f, i) => (
            <li key={`${f.name}-${f.size}-${i}`}>
              <Icon name="file" />
              <span className="ui-filedrop__name">{f.name}</span>
              <span className="ui-filedrop__size">{formatFileSize(f.size)}</span>
              {onRemove && (
                <button
                  type="button"
                  className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm"
                  onClick={() => onRemove(i)}
                  aria-label={t('common:file.removeFile', { name: f.name })}
                >
                  <Icon name="close" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
