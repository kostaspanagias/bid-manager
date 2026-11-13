/**
 * i18next setup — Greek only. One JSON namespace per feature under ./el/.
 * Feature engineers: add keys to your own namespace file; nothing to register here.
 *
 *   const { t } = useTranslation('requirements');
 *   t('title')                     // own namespace
 *   t('common:actions.save')       // shared strings
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import admin from './el/admin.json';
import auth from './el/auth.json';
import changes from './el/changes.json';
import common from './el/common.json';
import dashboard from './el/dashboard.json';
import documents from './el/documents.json';
import files from './el/files.json';
import gates from './el/gates.json';
import lessons from './el/lessons.json';
import my from './el/my.json';
import nav from './el/nav.json';
import requirements from './el/requirements.json';
import risks from './el/risks.json';
import schedule from './el/schedule.json';
import tasks from './el/tasks.json';
import templates from './el/templates.json';
import tenders from './el/tenders.json';
import watch from './el/watch.json';

export const resources = {
  el: {
    common,
    auth,
    nav,
    dashboard,
    tenders,
    schedule,
    gates,
    requirements,
    tasks,
    watch,
    risks,
    changes,
    files,
    documents,
    lessons,
    templates,
    admin,
    my,
  },
} as const;

export type Namespace = keyof (typeof resources)['el'];

void i18n.use(initReactI18next).init({
  resources,
  lng: 'el',
  fallbackLng: 'el',
  supportedLngs: ['el'],
  ns: Object.keys(resources.el),
  defaultNS: 'common',
  interpolation: { escapeValue: false }, // React escapes
  returnNull: false,
  initAsync: false,
  react: { useSuspense: false },
});

export default i18n;
