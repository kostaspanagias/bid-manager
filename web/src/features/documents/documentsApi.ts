/**
 * Company documents (F8), tender ↔ document links (R15) and the admin GDPR actions — contracts of
 * server/src/modules/{company-documents,documents,gdpr}.
 *
 *   /company-documents            GET (?type=&status=&include_archived=1) · POST · GET /expiring
 *   /company-documents/:id        GET · PATCH · DELETE · GET /download · PUT /file (multipart) · DELETE /file
 *                                 POST /archive · POST /unarchive
 *   /tenders/:id/documents        GET → { T, items, expired_count } · GET /suggestions · POST { company_document_id }
 *                                 DELETE /:companyDocumentId
 *   /gdpr/erase-person            POST { user_id?, person_name?, dry_run } · /gdpr/retention GET · PUT { retention_days }
 */
import { api, type ListResponse } from '@/api/client';
import type { CompanyDocumentType, DateString, ID, Timestamp } from '@/api/types';
import { uploadWithProgress } from '@/features/files/filesApi';
import { tenderKeys } from '@/features/tenders/tenderApi';

export type DocumentStatus = 'valid' | 'expiring' | 'expired';
export const DOCUMENT_STATUSES: DocumentStatus[] = ['valid', 'expiring', 'expired'];

export interface CompanyDocumentView {
  id: ID;
  type: CompanyDocumentType;
  title: string;
  issued_at: DateString | null;
  expires_at: DateString | null;
  person_name: string | null;
  notes: string | null;
  archived_at: Timestamp | null;
  status: DocumentStatus;
  days_to_expiry: number | null;
  file: { id: ID; filename: string; mime: string | null; size: number; uploaded_at: Timestamp } | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}
export interface DocumentInput {
  type: CompanyDocumentType;
  title: string;
  issued_at: DateString | null;
  expires_at: DateString | null;
  person_name: string | null;
  notes: string | null;
}
export interface LinkedDocument extends CompanyDocumentView {
  link_id: ID;
  linked_at: Timestamp;
  linked_by: ID | null;
  /** R15: expires_at < T */
  expires_before_T: boolean;
}
export interface SuggestionGroup {
  type: CompanyDocumentType;
  documents: Array<CompanyDocumentView & { expires_before_T: boolean }>;
}

export const documentsKeys = {
  all: ['company-documents'] as const,
  list: (includeArchived: boolean) => ['company-documents', 'list', includeArchived] as const,
  tender: (tenderId: ID) => [...tenderKeys.detail(tenderId), 'documents'] as const,
  suggestions: (tenderId: ID) => [...tenderKeys.detail(tenderId), 'documents', 'suggestions'] as const,
  retention: ['gdpr', 'retention'] as const,
};

export const listDocuments = (includeArchived: boolean) =>
  api.get<ListResponse<CompanyDocumentView>>('/company-documents', { query: { include_archived: includeArchived ? 1 : undefined } }).then((r) => r.items);
export const getDocument = (id: ID) => api.get<CompanyDocumentView>(`/company-documents/${id}`);
export const createDocument = (body: DocumentInput) => api.post<CompanyDocumentView>('/company-documents', body);
export const updateDocument = (id: ID, body: Partial<DocumentInput>) => api.patch<CompanyDocumentView>(`/company-documents/${id}`, body);
export const deleteDocument = (id: ID) => api.del(`/company-documents/${id}`);
export const archiveDocument = (id: ID, archived: boolean) => api.post<CompanyDocumentView>(`/company-documents/${id}/${archived ? 'archive' : 'unarchive'}`);
export const removeDocumentFile = (id: ID) => api.del<CompanyDocumentView>(`/company-documents/${id}/file`);
export const uploadDocumentFile = (id: ID, file: File, onProgress: (fraction: number) => void) =>
  uploadWithProgress<CompanyDocumentView>('PUT', `/company-documents/${id}/file`, file, {}, onProgress);
export const documentDownloadUrl = (id: ID) => api.downloadUrl(`/company-documents/${id}/download`);

export const listTenderDocuments = (tenderId: ID) => api.get<{ T: DateString; items: LinkedDocument[]; expired_count: number }>(`/tenders/${tenderId}/documents`);
export const listSuggestions = (tenderId: ID) => api.get<{ T: DateString; items: SuggestionGroup[] }>(`/tenders/${tenderId}/documents/suggestions`).then((r) => r.items);
export const linkDocument = (tenderId: ID, documentId: ID) => api.post<LinkedDocument>(`/tenders/${tenderId}/documents`, { company_document_id: documentId });
export const unlinkDocument = (tenderId: ID, documentId: ID) => api.del(`/tenders/${tenderId}/documents/${documentId}`);

export interface ErasePlan {
  dry_run: boolean;
  erased: boolean;
  user: { id: ID; name: string; email: string; org_role: string; active: boolean; already_anonymized: boolean } | null;
  documents: Array<{ id: ID; title: string; person_name: string | null; has_file: boolean; tenders: Array<{ id: ID; title: string }> }>;
  counts: { documents: number; files: number; tender_links: number; sessions: number; invitations: number; emails: number };
  matching_users: Array<{ id: ID; name: string; email: string }>;
}
export const erasePerson = (body: { user_id?: ID; person_name?: string; dry_run: boolean }) => api.post<ErasePlan>('/gdpr/erase-person', body);

export interface Retention {
  retention_days: number | null;
  pending: { tenders: number; files: number };
}
export const getRetention = () => api.get<Retention>('/gdpr/retention');
export const setRetention = (retention_days: number | null) => api.put<Retention>('/gdpr/retention', { retention_days });
