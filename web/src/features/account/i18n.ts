/**
 * The «account» namespace. src/i18n/index.ts belongs to the foundation and lists its namespaces statically, so
 * this feature registers its own bundle when its module is first imported (the router imports AccountPage
 * eagerly, i.e. before anything renders).
 */
import i18n from '@/i18n';
import account from './account.el.json';

if (!i18n.hasResourceBundle('el', 'account')) i18n.addResourceBundle('el', 'account', account);
