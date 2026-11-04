import { hasAnyPermission, hasPermission } from '../../auth/permissions';
import { DEMO_IDS } from '../../demo/fake/ids';
import type { GuideDefinition } from '../types';

const canReadJobs = (user: Parameters<GuideDefinition['requires']>[0]) => hasPermission(user, 'machine_jobs.read');
const canReadMachines = (user: Parameters<GuideDefinition['requires']>[0]) => hasPermission(user, 'machines.read');
const canReadInventory = (user: Parameters<GuideDefinition['requires']>[0]) => hasPermission(user, 'inventory.read');

const jobPage = /^\/workshop\/jobs\/(?!runs\/)[^/]+$/;

const tour: GuideDefinition = {
  id: 'workshop-tour',
  area: 'workshop',
  title: 'Workshop tour',
  summary: 'Where to find jobs, runs reported by machines, machines and the inventory.',
  duration: '3 min',
  kind: 'tour',
  demo: true,
  requires: (user) => hasAnyPermission(user, ['machine_jobs.read', 'machines.read', 'inventory.read']),
  steps: [
    {
      id: 'jobs-tabs',
      title: 'Jobs',
      body: 'A job is one piece of work for one recipient. This page lists all of them.\n\n"Needs attention" shows jobs with something to fix. "Recycle bin" holds removed jobs.',
      route: '/workshop/jobs',
      target: '[data-guide="workshop-jobs-tabs"]',
      placement: 'bottom',
      requires: canReadJobs,
    },
    {
      id: 'unassigned',
      title: 'Runs without a job',
      body: 'Printers report their runs by themselves. A run that belongs to no job yet waits in this strip until someone claims it.',
      target: '[data-guide="workshop-unassigned-strip"]',
      placement: 'bottom',
      requires: canReadJobs,
    },
    {
      id: 'toolbar',
      title: 'Search and filter',
      body: 'Search by job, machine or recipient. The filter button opens status, outcome, machine, billing and more.',
      target: '[data-guide="workshop-jobs-toolbar"]',
      placement: 'bottom',
      requires: canReadJobs,
    },
    {
      id: 'job-row',
      title: 'One row per job',
      body: 'Click a row to see the details next to the list, or open the job for the full page. The last column flags jobs that need attention.',
      target: '[data-guide="workshop-job-row"]',
      placement: 'top',
      requires: canReadJobs,
    },
    {
      id: 'job-detail',
      title: 'Inside a job',
      body: 'A job collects its runs: what was made, how long it took and how it ended. Material use, price and billing are on the same page.',
      route: `/workshop/jobs/${DEMO_IDS.job}`,
      target: '[data-guide="workshop-job-runs"]',
      placement: 'top',
      requires: canReadJobs,
    },
    {
      id: 'machines',
      title: 'Machines',
      body: 'Every machine with its availability, what it is doing now and when it last worked. Click a machine for its panel.',
      route: '/workshop/machines',
      target: '[data-guide="workshop-machines-table"]',
      placement: 'top',
      requires: canReadMachines,
    },
    {
      id: 'machine-tabs',
      title: 'Processes and printers',
      body: 'Processes group machines by the kind of work. Printers holds the 3D printer connections and their notifications.',
      target: '[data-guide="workshop-machines-tabs"]',
      placement: 'bottom',
      requires: canReadMachines,
    },
    {
      id: 'inventory-articles',
      title: 'Inventory',
      body: 'Articles are the things you stock, with quantity and stock level. "Categories" defines the material types. Removed items rest in the recycle bin.',
      route: '/workshop/inventory',
      target: '[data-guide="workshop-inventory-tabs"]',
      placement: 'bottom',
      requires: canReadInventory,
    },
    {
      id: 'inventory-spools',
      title: 'Filament spools',
      body: 'Each filament spool is tracked on its own, with what is left on it and where it is mounted.',
      route: '/workshop/inventory?tab=spools',
      target: '[data-guide="workshop-inventory-tabs"]',
      placement: 'bottom',
      requires: canReadInventory,
    },
  ],
};

const logJob: GuideDefinition = {
  id: 'workshop-log-job',
  area: 'workshop',
  title: 'Log a job by hand',
  summary: 'Record work on a machine that does not report by itself.',
  duration: '3 min',
  kind: 'workflow',
  demo: true,
  requires: (user) =>
    hasPermission(user, 'machine_jobs.read') &&
    hasPermission(user, 'machine_jobs.create') &&
    hasPermission(user, 'machines.read'),
  steps: [
    {
      id: 'new-job',
      title: 'Start a new job',
      body: 'Click "New job".',
      route: '/workshop/jobs',
      target: '[data-guide="workshop-new-job"]',
      placement: 'bottom',
      advance: { kind: 'click' },
    },
    {
      id: 'machine',
      title: 'Choose the machine',
      body: 'Pick the machine that did the work, for example the laser cutter. Then press Next.',
      target: '#job-form-machine',
      placement: 'right',
    },
    {
      id: 'recipient',
      title: 'Choose the recipient',
      body: 'This is the member or organization the job is for and who pays for it. Pick one, then press Next.',
      target: '#job-form-customer',
      placement: 'right',
    },
    {
      id: 'operator',
      title: 'Check the operator',
      body: 'The operator is the person responsible. It is you by default; change it if someone else did the work.',
      target: '#job-form-operator',
      placement: 'left',
    },
    {
      id: 'first-run',
      title: 'Describe the first run',
      body: 'Say whether the run starts now or is already done, and how long it takes. You can add the material used here as well.',
      target: '[data-guide="workshop-job-run"]',
      placement: 'top',
    },
    {
      id: 'create',
      title: 'Create the job',
      body: 'Click "Create job". Nothing is saved for real in this demo.',
      target: '[data-guide="workshop-job-submit"]',
      placement: 'top',
      advance: { kind: 'route', pattern: jobPage },
    },
    {
      id: 'result',
      title: 'Your job',
      body: 'The job page shows the run you entered. Later you can add runs, record the outcome and see the price.',
      target: '[data-guide="workshop-job-runs"]',
      placement: 'top',
    },
  ],
};

const claimRun: GuideDefinition = {
  id: 'workshop-claim-run',
  area: 'workshop',
  title: 'Claim a run from a machine',
  summary: 'Turn a run that a printer reported by itself into a job.',
  duration: '2 min',
  kind: 'workflow',
  demo: true,
  requires: (user) => hasPermission(user, 'machine_jobs.read') && hasPermission(user, 'machine_jobs.create'),
  steps: [
    {
      id: 'strip',
      title: 'A run nobody owns yet',
      body: 'The printer reported these runs, but they belong to no job. Someone has to say whom the work was for.',
      route: '/workshop/jobs',
      target: '[data-guide="workshop-unassigned-strip"]',
      placement: 'bottom',
    },
    {
      id: 'claim',
      title: 'Claim the run',
      body: 'Click "Claim" on a run.',
      target: '[data-guide="workshop-claim-run"]',
      placement: 'left',
      advance: { kind: 'click' },
    },
    {
      id: 'mode',
      title: 'New job or existing job',
      body: 'You can attach the run to an open job on the same machine. Here, choose "New job", then press Next.',
      target: '[data-guide="workshop-claim-mode"]',
      placement: 'right',
    },
    {
      id: 'recipient',
      title: 'Choose the recipient',
      body: 'Pick the member or organization the print was for. You are the operator by default.',
      target: '#claim-customer',
      placement: 'right',
    },
    {
      id: 'title',
      title: 'Name the job',
      body: 'A title is optional. Without one, the file name of the run is used.',
      target: '#claim-title',
      placement: 'right',
    },
    {
      id: 'create',
      title: 'Create the job',
      body: 'Click "Create job". The run becomes its first run.',
      target: '[data-guide="workshop-claim-submit"]',
      placement: 'top',
      advance: { kind: 'route', pattern: jobPage },
    },
    {
      id: 'result',
      title: 'The job has its run',
      body: 'The run is now part of the job. It is gone from the strip, and the material it used is booked.',
      target: '[data-guide="workshop-job-runs"]',
      placement: 'top',
    },
  ],
};

const receiveStock: GuideDefinition = {
  id: 'workshop-receive-stock',
  area: 'workshop',
  title: 'Receive stock',
  summary: 'Book a delivery of filament or other material into the inventory.',
  duration: '2 min',
  kind: 'workflow',
  demo: true,
  requires: (user) => hasPermission(user, 'inventory.read') && hasPermission(user, 'inventory.manage'),
  steps: [
    {
      id: 'open',
      title: 'Receive a delivery',
      body: 'Click "Receive stock" when new material arrives.',
      route: '/workshop/inventory',
      target: '[data-guide="workshop-receive-stock"]',
      placement: 'bottom',
      advance: { kind: 'click' },
    },
    {
      id: 'article',
      title: 'Choose the article',
      body: 'Pick the article that was delivered, for example "PLA Basic Black". For something new, choose "New article" in the list. Then press Next.',
      target: '#receive-article',
      placement: 'right',
    },
    {
      id: 'packages',
      title: 'How much arrived',
      body: 'Enter the number of packages. The size of one package is filled in from the article.',
      target: '#receive-count',
      placement: 'right',
    },
    {
      id: 'price',
      title: 'What it cost',
      body: 'Enter the total price for all packages together. It sets the cost of the stock.',
      target: '#receive-price',
      placement: 'right',
    },
    {
      id: 'submit',
      title: 'Book it',
      body: 'Click "Receive stock" at the bottom. Nothing is saved for real in this demo.',
      target: '[data-guide="workshop-receive-modal"] .cds--modal-footer .cds--btn--primary',
      placement: 'top',
      advance: { kind: 'click' },
    },
    {
      id: 'result',
      title: 'Stock is updated',
      body: 'The quantity of the article went up. Open the article to see the delivery in its ledger.',
      target: '[data-guide="workshop-inventory-list"]',
      placement: 'top',
    },
  ],
};

export const workshopGuides: GuideDefinition[] = [tour, logJob, claimRun, receiveStock];
