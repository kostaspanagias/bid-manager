/**
 * Tender files — contract of server/src/modules/files (mounted at /api/tenders/:tenderId/files).
 *
 *   GET    /                    → { items: TenderFile[], can_see_financial }   (?folder=)
 *   POST   /                    multipart: file | files[], folder, label?, confidentiality? → 201 { items }
 *   GET    /:id                 → TenderFile            GET /:id/download (?inline=1) → the file
 *   PATCH  /:id                 { filename?, label?, folder?, confidentiality? } → TenderFile
 *   DELETE /:id                 → 204
 * Financial files (R18) are absent from the list and answer 403 `financial_restricted` to anyone without access.
 */
import { api, ApiError, type ListResponse } from '@/api/client';
import type { FileConfidentiality, FileFolder, ID, Timestamp } from '@/api/types';
import { tenderKeys } from '@/features/tenders/tenderApi';
import i18n from '@/i18n';

export interface TenderFile {
  id: ID;
  tender_id: ID;
  filename: string;
  mime: string | null;
  size: number;
  sha256: string | null;
  folder: FileFolder;
  confidentiality: FileConfidentiality;
  label: string | null;
  uploaded_by: ID | null;
  uploaded_by_name: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export const filesKeys = { list: (tenderId: ID) => [...tenderKeys.detail(tenderId), 'files'] as const };

export const listFiles = (tenderId: ID) =>
  api.get<ListResponse<TenderFile> & { can_see_financial: boolean }>(`/tenders/${tenderId}/files`).then((r) => r.items);
export const getFile = (tenderId: ID, fileId: ID) => api.get<TenderFile>(`/tenders/${tenderId}/files/${fileId}`);
export const patchFile = (tenderId: ID, fileId: ID, body: Partial<Pick<TenderFile, 'filename' | 'label' | 'folder' | 'confidentiality'>>) =>
  api.patch<TenderFile>(`/tenders/${tenderId}/files/${fileId}`, body);
export const deleteFile = (tenderId: ID, fileId: ID) => api.del(`/tenders/${tenderId}/files/${fileId}`);
export const fileDownloadUrl = (tenderId: ID, fileId: ID) => api.downloadUrl(`/tenders/${tenderId}/files/${fileId}/download`);

export const uploadTenderFile = (
  tenderId: ID,
  file: File,
  fields: { folder: FileFolder; label?: string },
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
) => uploadWithProgress<ListResponse<TenderFile>>('POST', `/tenders/${tenderId}/files`, file, fields, onProgress, signal);

/** Starts a browser download of a URL the caller has already checked the user may fetch. */
export function startDownload(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function translate(code: string, fallback: string): string {
  for (const ns of (i18n.options.ns ?? []) as string[]) {
    if (i18n.exists(`${ns}:errorCodes.${code}`)) return i18n.t(`${ns}:errorCodes.${code}`);
  }
  return fallback;
}

/**
 * Multipart upload with progress. fetch() cannot report upload progress, so this one request uses XMLHttpRequest;
 * the CSRF token is the one GET /api/auth/me hands out (same as api/client.ts uses). Errors are ApiError, with the
 * same code → Greek message translation as the rest of the app.
 */
export async function uploadWithProgress<T>(
  method: 'POST' | 'PUT',
  path: string,
  file: File,
  fields: Record<string, string | null | undefined>,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  const { csrfToken } = await api.get<{ csrfToken: string }>('/auth/me');
  const form = new FormData();
  // fields first: the server reads them before the file part arrives
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') form.append(k, v);
  form.append('file', file, file.name);

  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, `/api${path}`);
    xhr.withCredentials = true;
    xhr.responseType = 'text';
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.total === 0 ? 1 : e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'network_error', i18n.t('common:errors.network')));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        /* non-JSON (proxy error page) */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve(body as T);
        return;
      }
      const e = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      const code = e?.code ?? `http_${xhr.status}`;
      const fallback = e?.message || i18n.t(xhr.status === 413 ? 'common:errors.tooLarge' : xhr.status === 403 ? 'common:errors.forbidden' : 'common:errors.generic');
      reject(new ApiError(xhr.status, code, translate(code, fallback), e?.details, e?.message ?? ''));
    };
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(form);
  });
}
