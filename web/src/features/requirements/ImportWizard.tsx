import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/client';
import type { ID } from '@/api/types';
import { cx } from '@/lib/cx';
import { Badge, Banner, Button, Checkbox, Field, FileDropInput, Modal, Select, Spinner, Table, useToast, type Column, type Tone } from '@/ui';
import {
  IMPORT_FIELDS,
  IMPORT_MAX_MB,
  commitImport,
  previewImport,
  templateUrl,
  type ImportAction,
  type ImportField,
  type ImportMapping,
  type ImportPreview,
  type ImportProblem,
  type ImportResult,
  type ImportRow,
} from './requirementsApi';

interface Props {
  tenderId: ID;
  onClose: () => void;
  /** Called after a successful commit (the register must be re-read) */
  onImported: (result: ImportResult) => void;
}

type Step = 'upload' | 'mapping' | 'summary';
const STEPS: Step[] = ['upload', 'mapping', 'summary'];
const ACTION_TONE: Record<ImportAction, Tone> = { create: 'green', update: 'info', unchanged: 'neutral', error: 'red' };
const PREVIEW_ROWS = 50;

const columnLetter = (index: number): string => {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** upload → column mapping with preview and per-row problems → summary (overwrite option) → commit. */
export function ImportWizard({ tenderId, onClose, onImported }: Props) {
  const { t } = useTranslation('requirements');
  const toast = useToast();
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [mapping, setMapping] = useState<ImportMapping | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  /** Every change of file / sheet / mapping / overwrite re-runs the server-side preview (nothing is written). */
  const run = async (f: File, opts: { sheet: string | null; mapping: ImportMapping | null; overwrite: boolean }) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const res = await previewImport(tenderId, f, opts, controller.signal);
      if (controller.signal.aborted) return;
      setPreview(res);
      setMapping(res.mapping);
      setSheet(res.file.sheet);
      setStep((s) => (s === 'upload' ? 'mapping' : s));
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(errorMessage(err));
      if (!opts.mapping && !opts.sheet) {
        setFile(null);
        setPreview(null);
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  const choose = (files: File[]) => {
    const f = files[0];
    if (!f) return;
    setFile(f);
    setPreview(null);
    setMapping(null);
    setSheet(null);
    setOverwrite(false);
    setSkipInvalid(false);
    setOnlyProblems(false);
    void run(f, { sheet: null, mapping: null, overwrite: false });
  };
  const restart = () => {
    request.current?.abort();
    setFile(null);
    setPreview(null);
    setError(null);
    setLoading(false);
    setStep('upload');
  };
  const changeMapping = (field: ImportField, value: string) => {
    if (!file || !mapping) return;
    const next = { ...mapping, [field]: value === '' ? null : Number(value) };
    setMapping(next);
    void run(file, { sheet, mapping: next, overwrite });
  };
  const changeSheet = (name: string) => {
    if (!file) return;
    setSheet(name);
    setMapping(null);
    void run(file, { sheet: name, mapping: null, overwrite });
  };
  const changeOverwrite = (value: boolean) => {
    if (!file) return;
    setOverwrite(value);
    void run(file, { sheet, mapping, overwrite: value });
  };

  const commit = useMutation({
    mutationFn: () => commitImport(tenderId, file as File, { sheet, mapping, overwrite, skipInvalid }),
    onSuccess: (res) => {
      toast.success(t(res.skipped > 0 ? 'import.doneSkipped' : 'import.done', { ...res }));
      onImported(res);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const summary = preview?.summary;
  const toWrite = summary ? summary.create + summary.update : 0;
  const codeMapped = mapping?.code !== null && mapping?.code !== undefined;
  const canCommit = Boolean(summary && codeMapped && toWrite > 0 && (summary.errors === 0 || skipInvalid) && !loading);
  const problemRows = preview?.rows.filter((r) => r.errors.length > 0 || r.warnings.length > 0) ?? [];
  const shownRows = (onlyProblems ? problemRows : (preview?.rows ?? [])).slice(0, PREVIEW_ROWS);
  const totalRows = onlyProblems ? problemRows.length : (preview?.rows.length ?? 0);

  const problemText = (p: ImportProblem) => t(`import.problem.${p.code}`, { value: p.value ?? '', firstRow: p.firstRow ?? '', field: t(`columns.${p.field === 'owner' ? 'owner' : p.field}`) });
  const fieldNames = (fields: string[]) =>
    [...new Set(fields.map((f) => (f === 'owner_user_id' || f === 'owner_role_key' ? 'owner' : f)))].map((f) => t(`columns.${f}`)).join(', ');
  const previewColumns: Column<ImportRow>[] = [
    { key: 'row', header: t('import.row'), width: 76, mono: true },
    { key: 'code', header: t('columns.code'), width: 92, mono: true },
    { key: 'action', header: t('import.result'), width: 124, render: (r) => <Badge tone={ACTION_TONE[r.action]}>{t(`import.action.${r.action}`)}</Badge> },
    {
      key: 'text',
      header: t('import.textAndProblems'),
      wrap: true,
      render: (r) => (
        <>
          <span className="reg-preview__text" title={r.values.text}>
            {r.values.text ?? <span className="u-faint">—</span>}
          </span>
          {r.errors.length + r.warnings.length + r.kept.length + r.changed.length > 0 && (
            <ul className="reg-problems">
              {r.errors.map((p, i) => (
                <li key={`e${i}`} className="is-error">
                  {problemText(p)}
                </li>
              ))}
              {r.warnings.map((p, i) => (
                <li key={`w${i}`} className="is-warning">
                  {problemText(p)}
                </li>
              ))}
              {r.action === 'update' && r.changed.length > 0 && <li className="is-kept">{t('import.changedFields', { fields: fieldNames(r.changed) })}</li>}
              {r.action !== 'error' && r.kept.length > 0 && <li className="is-kept">{t('import.keptFields', { fields: fieldNames(r.kept) })}</li>}
            </ul>
          )}
        </>
      ),
    },
  ];

  const footer = (
    <>
      {step !== 'upload' && (
        <Button className="reg-footer-split" onClick={restart} disabled={commit.isPending}>
          {t('import.changeFile')}
        </Button>
      )}
      {step === 'summary' && (
        <Button onClick={() => setStep('mapping')} disabled={commit.isPending}>
          {t('common:actions.back')}
        </Button>
      )}
      {step !== 'summary' && (
        <Button onClick={onClose} disabled={commit.isPending}>
          {t('common:actions.cancel')}
        </Button>
      )}
      {step === 'mapping' && (
        <Button variant="primary" disabled={!preview || loading || !codeMapped || preview.rows.length === 0} onClick={() => setStep('summary')}>
          {t('common:actions.next')}
        </Button>
      )}
      {step === 'summary' && (
        <Button variant="primary" icon="upload" loading={commit.isPending} disabled={!canCommit} onClick={() => commit.mutate()}>
          {toWrite > 0 ? t('import.commitCount', { count: toWrite }) : t('import.commit')}
        </Button>
      )}
    </>
  );

  return (
    <Modal open size="lg" onClose={onClose} closeOnBackdrop={step === 'upload' && !loading} title={t('import.title')} footer={footer}>
      <ol className="reg-steps">
        {STEPS.map((s, i) => (
          <li key={s} className={cx(s === step && 'is-current', STEPS.indexOf(step) > i && 'is-done')} aria-current={s === step ? 'step' : undefined}>
            {t(`import.steps.${s}`)}
          </li>
        ))}
      </ol>

      {error && (
        <Banner tone="red" className="reg-import__error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}

      {step === 'upload' && (
        <>
          <p className="u-muted">{t('import.intro')}</p>
          <FileDropInput accept=".csv,.xlsx,.txt" maxSizeMb={IMPORT_MAX_MB} label={t('import.dropLabel')} hint={t('import.drop', { mb: IMPORT_MAX_MB })} onFiles={choose} onReject={(m) => setError(m)} disabled={loading} />
          {loading && (
            <p className="reg-import__busy">
              <Spinner /> {t('import.reading')}
            </p>
          )}
          <div className="reg-import__links">
            <a href={templateUrl(tenderId)} download>
              {t('actions.template')}
            </a>
            <span className="u-muted">{t('import.formatDoc')}</span>
          </div>
        </>
      )}

      {step !== 'upload' && preview && (
        <p className="reg-import__file">
          <strong>{preview.file.name}</strong>
          <span>{t('import.fileRows', { count: preview.file.rows })}</span>
          {loading && (
            <span className="reg-import__busy">
              <Spinner /> {t('import.checking')}
            </span>
          )}
        </p>
      )}

      {step === 'mapping' && preview && mapping && (
        <>
          {preview.file.encoding === 'windows-1253' && <Banner tone="orange">{t('import.encoding1253')}</Banner>}
          <div className="reg-import__subhead">
            <h3>{t('import.mappingTitle')}</h3>
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => file && void run(file, { sheet, mapping: null, overwrite })}>
              {t('import.resetMapping')}
            </Button>
          </div>
          <div className="reg-map">
            {preview.file.sheets.length > 1 && (
              <Field label={t('import.sheet')}>
                <Select value={sheet ?? ''} onChange={(e) => changeSheet(e.target.value)} options={preview.file.sheets.map((s) => ({ value: s, label: s }))} />
              </Field>
            )}
            {IMPORT_FIELDS.map((field) => {
              const index = mapping[field];
              const sample = index !== null ? preview.columns[index]?.sample.find((v) => v !== '') : undefined;
              return (
                <Field
                  key={field}
                  label={t(`columns.${field}`)}
                  required={field === 'code'}
                  hint={sample ? t('import.sample', { value: sample.length > 40 ? `${sample.slice(0, 40)}…` : sample }) : undefined}
                  error={field === 'code' && index === null ? t('import.codeUnmapped') : undefined}
                >
                  <Select value={index === null ? '' : String(index)} onChange={(e) => changeMapping(field, e.target.value)} placeholder={t('import.notImported')}>
                    {preview.columns.map((c) => (
                      <option key={c.index} value={c.index}>
                        {t('import.columnOption', { letter: columnLetter(c.index), header: c.header || t('import.columnUnnamed') })}
                      </option>
                    ))}
                  </Select>
                </Field>
              );
            })}
          </div>

          <div className="reg-import__subhead">
            <h3>
              {t('import.previewTitle')}{' '}
              <span className="u-muted" style={{ fontWeight: 'normal' }}>
                · {t('import.summary.create')} {preview.summary.create} · {t('import.summary.update')} {preview.summary.update} · {t('import.summary.unchanged')} {preview.summary.unchanged} ·{' '}
                {t('import.summary.errors')} {preview.summary.errors}
              </span>
            </h3>
            {problemRows.length > 0 && <Checkbox label={t('import.onlyProblems', { count: problemRows.length })} checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />}
          </div>
          <Table columns={previewColumns} rows={shownRows} rowKey={(r) => String(r.row)} rowTone={(r) => (r.errors.length > 0 ? 'red' : r.warnings.length > 0 ? 'orange' : undefined)} dense stickyHeader maxHeight={300} emptyTitle={t('import.noRows')} className="reg-preview" />
          {totalRows > shownRows.length && <p className="u-muted reg-coverage__note">{t('import.previewShown', { shown: shownRows.length, total: totalRows })}</p>}
        </>
      )}

      {step === 'summary' && summary && (
        <>
          <div className="reg-tiles">
            {(
              [
                ['create', 'green'],
                ['update', 'info'],
                ['unchanged', 'neutral'],
                ['errors', summary.errors > 0 ? 'red' : 'neutral'],
              ] as const
            ).map(([key, tone]) => (
              <div key={key} className={cx('reg-tile', `ui-tone-${tone}`)}>
                <span className="reg-tile__n">{summary[key]}</span>
                <span className="reg-tile__label">{t(`import.summary.${key}`)}</span>
              </div>
            ))}
          </div>
          <div className="reg-import__options">
            {toWrite === 0 && summary.errors === 0 && <Banner tone="info">{t('import.nothingToDo')}</Banner>}
            {summary.errors > 0 && (
              <Banner
                tone="red"
                title={t('import.errorsTitle')}
                actions={
                  <Button
                    size="sm"
                    onClick={() => {
                      setOnlyProblems(true);
                      setStep('mapping');
                    }}
                  >
                    {t('import.backToRows')}
                  </Button>
                }
              >
                {t('import.errorsBody')}
              </Banner>
            )}
            {summary.errors > 0 && <Checkbox label={t('import.skipInvalid', { count: summary.errors })} checked={skipInvalid} onChange={(e) => setSkipInvalid(e.target.checked)} />}
            <Checkbox label={t('import.overwrite')} hint={t('import.overwriteHint')} checked={overwrite} disabled={loading || commit.isPending} onChange={(e) => changeOverwrite(e.target.checked)} />
            {summary.kept > 0 && <Banner tone="orange">{t('import.keptNote', { count: summary.kept })}</Banner>}
            {summary.warnings > 0 && <p className="u-muted">{t('import.warningsNote', { count: summary.warnings })}</p>}
            <p className="u-muted">{t('import.rules')}</p>
          </div>
        </>
      )}
    </Modal>
  );
}
