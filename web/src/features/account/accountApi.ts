/**
 * Account — contract of server/src/core/authRoutes.ts.
 *
 *   POST /api/auth/change-password { current_password, new_password } → { ok: true }
 *     422 wrong_current_password · 422 password_unchanged · 400 validation_error (new password < 12 chars) · 429
 *     Every other session of the user ends; the current one stays.
 */
import { api } from '@/api/client';

export const changePassword = (current_password: string, new_password: string) => api.post<{ ok: true }>('/auth/change-password', { current_password, new_password });
