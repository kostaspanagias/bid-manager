/**
 * API client — the only place that calls fetch().
 *
 *   api.get<T>('/tenders', { query: { status: 'in_progress' } })
 *   api.post<T>('/tenders', body)   api.put / api.patch / api.del
 *   api.upload<T>('/tenders/1/files', formData)        multipart
 *   api.downloadUrl('/files/1/download')               → '/api/files/1/download' for <a href>
 *
 * - Paths are relative to /api. Cookies are always sent.
 * - Mutating requests carry X-CSRF-Token (value handed over by AuthProvider from GET /api/auth/me).
 * - Errors `{ error: { code, message, details? } }` become ApiError.
 * - A 401 calls the handler registered by AuthProvider (→ login screen, "session expired").
 */
import i18n from '@/i18n';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;
  /** The untranslated message the server sent (English), for logs */
  readonly serverMessage: string;

  /** `message` is the text to show the user (Greek when the code is known, see translateCode). */
  constructor(status: number, code: string, message: string, details?: unknown, serverMessage = '') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.serverMessage = serverMessage;
  }

  /** Field errors of a 400 validation response, if `details` is a { field: message } map or zod-like issue list. */
  get fieldErrors(): Record<string, string> {
    const d = this.details;
    const out: Record<string, string> = {};
    if (Array.isArray(d)) {
      for (const issue of d) {
        if (issue && typeof issue === 'object') {
          const i = issue as { path?: unknown; message?: unknown };
          const path = Array.isArray(i.path) ? i.path.join('.') : typeof i.path === 'string' ? i.path : '';
          if (path && typeof i.message === 'string' && !(path in out)) out[path] = i.message;
        }
      }
    } else if (d && typeof d === 'object') {
      const src = (d as { fieldErrors?: unknown }).fieldErrors ?? d;
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
        else if (Array.isArray(v) && typeof v[0] === 'string') out[k] = v[0];
      }
    }
    return out;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** Human-readable (Greek) message for any thrown value — use in toasts and banners. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError && err.message) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return i18n.t('common:errors.generic');
}

export type QueryParams = Record<string, string | number | boolean | null | undefined | Array<string | number>>;

export interface RequestOptions {
  query?: QueryParams;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Do not trigger the global "session expired" handling on 401 (used by the auth endpoints). */
  skipAuthRedirect?: boolean;
}

const API_BASE = '/api';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

let csrfToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

/** Called by AuthProvider with the token from GET /api/auth/me (null on logout). */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Called by AuthProvider; invoked on any 401 outside the auth endpoints. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

function buildUrl(path: string, query?: QueryParams): string {
  const base = path.startsWith('/api/') ? path : `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
  if (!query) return base;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach((v) => qs.append(key, String(v)));
    else qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `${base}?${s}` : base;
}

function fallbackMessage(status: number): string {
  const key =
    status === 0
      ? 'network'
      : status === 401
        ? 'unauthorized'
        : status === 403
          ? 'forbidden'
          : status === 404
            ? 'notFound'
            : status === 413
              ? 'tooLarge'
              : status === 429
                ? 'rateLimited'
              : status >= 500
                ? 'server'
                : 'generic';
  return i18n.t(`common:errors.${key}`);
}

/**
 * The server's messages are English; the UI is Greek. A code is translated when ANY namespace defines
 * `errorCodes.<code>` — generic ones live in common.json, feature-specific ones in the feature's own file.
 * Unknown codes fall back to the server message.
 */
function translateCode(code: string): string | null {
  const namespaces = (i18n.options.ns ?? []) as string[];
  for (const ns of namespaces) {
    const key = `${ns}:errorCodes.${code}`;
    if (i18n.exists(key)) return i18n.t(key);
  }
  return null;
}

async function parseError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = '';
  let details: unknown;
  try {
    const body: unknown = await res.json();
    const e = (body as { error?: unknown } | null)?.error;
    if (e && typeof e === 'object') {
      const err = e as { code?: unknown; message?: unknown; details?: unknown };
      if (typeof err.code === 'string') code = err.code;
      if (typeof err.message === 'string') message = err.message;
      details = err.details;
    } else if (typeof e === 'string') {
      message = e;
    }
  } catch {
    /* non-JSON error body (proxy error page etc.) */
  }
  return new ApiError(res.status, code, translateCode(code) ?? (message || fallbackMessage(res.status)), details, message);
}

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body; // the browser sets the multipart boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (!SAFE_METHODS.has(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      body: payload,
      credentials: 'include',
      signal: opts.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'network_error', fallbackMessage(0));
  }

  if (!res.ok) {
    const err = await parseError(res);
    if (res.status === 401 && !opts.skipAuthRedirect) unauthorizedHandler?.();
    throw err;
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) return (await res.text()) as unknown as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body ?? {}, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, body ?? {}, opts),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, body ?? {}, opts),
  del: <T = void>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, undefined, opts),

  /**
   * Multipart upload. Pass a ready FormData, or `{ file, fields }` (file goes in the "file" part,
   * multiple files in repeated "files" parts).
   */
  upload: <T>(
    path: string,
    data: FormData | { file?: File; files?: File[]; fields?: Record<string, string | number | boolean | null | undefined> },
    opts?: RequestOptions & { method?: 'POST' | 'PUT' | 'PATCH' },
  ) => {
    let form: FormData;
    if (data instanceof FormData) {
      form = data;
    } else {
      form = new FormData();
      for (const [k, v] of Object.entries(data.fields ?? {})) {
        if (v !== undefined && v !== null) form.append(k, String(v));
      }
      if (data.file) form.append('file', data.file, data.file.name);
      for (const f of data.files ?? []) form.append('files', f, f.name);
    }
    return request<T>(opts?.method ?? 'POST', path, form, opts);
  },

  /** Absolute-path URL for links/downloads handled by the browser (cookies go along, GET needs no CSRF). */
  downloadUrl: (path: string, query?: QueryParams) => buildUrl(path, query),
};

/** Standard list envelope. */
export interface ListResponse<T> {
  items: T[];
}
export interface PagedResponse<T> extends ListResponse<T> {
  total: number;
}
