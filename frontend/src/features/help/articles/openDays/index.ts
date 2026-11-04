import type { HelpArticle } from '../index';
import { canAccessOpenDays, hasPermission } from '../../../auth/permissions';

export const openDaysArticles: HelpArticle[] = [
  {
    id: 'open-days-overview',
    area: 'open-days',
    title: 'What open days are',
    summary: 'Open days, periods and the places supervisors and trainees fill.',
    requires: canAccessOpenDays,
    relatedGuides: ['open-days-tour'],
    load: () => import('./what-are-open-days.md?raw').then((module) => module.default),
  },
  {
    id: 'open-days-sign-up',
    area: 'open-days',
    title: 'Signing up and leaving',
    summary: 'The semester minimum, trainees and supervisors, and how to join or leave a day.',
    requires: (user) => canAccessOpenDays(user) && hasPermission(user, 'open_days.signup'),
    relatedGuides: ['open-days-sign-up'],
    load: () => import('./sign-up-and-leave.md?raw').then((module) => module.default),
  },
  {
    id: 'open-days-assign',
    area: 'open-days',
    title: 'Assigning people to open days',
    summary: 'Fill free places with eligible members and remove assignments.',
    requires: (user) => canAccessOpenDays(user) && hasPermission(user, 'open_days.assign'),
    relatedGuides: ['open-days-assign'],
    load: () => import('./assign-people.md?raw').then((module) => module.default),
  },
];
