import { hasPermission } from '../../../auth/permissions';
import type { HelpArticle } from '../index';

export const workshopArticles: HelpArticle[] = [
  {
    id: 'workshop-jobs-and-runs',
    area: 'workshop',
    title: 'Jobs and runs',
    summary: 'What a job and a run are, how to log or claim work, and what needs attention.',
    requires: (user) => hasPermission(user, 'machine_jobs.read'),
    relatedGuides: ['workshop-tour', 'workshop-log-job', 'workshop-claim-run'],
    load: () => import('./jobs-and-runs.md?raw').then((module) => module.default),
  },
  {
    id: 'workshop-machines',
    area: 'workshop',
    title: 'Machines',
    summary: 'Availability, activity and connectors, and how the machine list works.',
    requires: (user) => hasPermission(user, 'machines.read'),
    relatedGuides: ['workshop-tour'],
    load: () => import('./machines.md?raw').then((module) => module.default),
  },
  {
    id: 'workshop-inventory-and-spools',
    area: 'workshop',
    title: 'Inventory and filament spools',
    summary: 'Articles, receiving stock and how filament spools are tracked.',
    requires: (user) => hasPermission(user, 'inventory.read'),
    relatedGuides: ['workshop-tour', 'workshop-receive-stock'],
    load: () => import('./inventory-and-spools.md?raw').then((module) => module.default),
  },
  {
    id: 'workshop-billing-a-job',
    area: 'workshop',
    title: 'Who pays for a job',
    summary: 'How a job is priced and how it gets onto an order.',
    requires: (user) => hasPermission(user, 'machine_jobs.read'),
    relatedGuides: ['workshop-tour'],
    load: () => import('./billing-a-job.md?raw').then((module) => module.default),
  },
];
