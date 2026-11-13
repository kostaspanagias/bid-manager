import type { OrgRole } from '@/api/types';
import type { IconName } from '@/ui';

export interface NavItem {
  /** Route path */
  to: string;
  /** i18n key in the `nav` namespace */
  labelKey: string;
  icon: IconName;
  /** Match the path exactly (for "/") */
  end?: boolean;
}

export interface NavGroup {
  /** i18n key of the group heading; omitted for the main group */
  labelKey?: string;
  /** Visible only to these org roles (all roles when omitted) */
  roles?: OrgRole[];
  items: NavItem[];
}

/** The app's navigation. Already complete for the MVP — feature work does not need to touch it. */
export const NAV: NavGroup[] = [
  {
    items: [
      { to: '/', labelKey: 'dashboard', icon: 'dashboard', end: true },
      { to: '/tenders', labelKey: 'tenders', icon: 'folder' },
      { to: '/my', labelKey: 'my', icon: 'inbox' },
      { to: '/company-documents', labelKey: 'companyDocuments', icon: 'file' },
    ],
  },
  {
    labelKey: 'admin',
    roles: ['admin'],
    items: [
      { to: '/admin/users', labelKey: 'users', icon: 'users' },
      { to: '/admin/templates', labelKey: 'templates', icon: 'layers' },
      { to: '/admin/holidays', labelKey: 'holidays', icon: 'calendar' },
      { to: '/admin/audit', labelKey: 'audit', icon: 'history' },
    ],
  },
];
