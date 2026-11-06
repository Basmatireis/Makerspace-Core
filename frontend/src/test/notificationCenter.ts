import type { NotificationCatalog, NotificationCategory, NotificationRule } from '../api/generated/models';

const field = (
  key: string,
  label: string,
  type: string,
  options: { value: string; label: string }[] = [],
  unit: string | null = null,
) => ({
  key,
  label,
  type,
  options,
  unit,
});

export const catalogFixture: NotificationCatalog = {
  triggers: [
    {
      key: 'printer_error',
      area: 'Machines',
      label: 'A printer reports an error',
      help: 'Fires when a printer reports an error.',
      subject: 'lab',
      fields: [
        field('severity', 'Severity', 'ordered', [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' },
        ]),
      ],
      recipients: [{ key: 'machine_supervisors', label: 'Supervisors of the machine' }],
      placeholders: [{ key: 'machine', label: 'Machine name', example: 'Bambu Lab H2D' }],
      resolutions: [{ key: 'error_cleared', label: 'The error is cleared' }],
      throttleSubjects: [{ key: 'machine', label: 'each machine' }],
    },
  ],
  collections: [
    {
      key: 'people',
      label: 'People',
      one: 'person',
      plural: 'people',
      placeholderPrefix: 'person',
      fields: [field('name', 'Name', 'text'), field('unpaid', 'Unpaid amount', 'number', [], '€')],
      summaryFields: [field('count', 'Matching people', 'number')],
      recipients: [{ key: 'self', label: 'The person itself' }],
    },
  ],
  recipientFields: [field('checkedIn', 'Checked in right now', 'bool')],
  nowFields: [field('weekday', 'Weekday', 'enum', [{ value: 'mon', label: 'Mon' }])],
  openDay: { fields: [], placeholders: [], recipients: [] },
  resolutions: [{ key: 'acknowledged', label: 'Someone acknowledges it' }],
  repeats: [
    { key: 'daily', label: 'Every day' },
    { key: 'weekdays', label: 'Every weekday (Mon–Fri)' },
    { key: 'weekly', label: 'Every week on…' },
    { key: 'monthly', label: 'Every month on day…' },
    { key: 'before_open_day', label: 'Before each open day' },
    { key: 'after_open_day', label: 'After each open day' },
  ],
};

export const serviceCategoryId = '0192f6f8-743e-7c77-a349-cd07c3e8c001';
export const newsCategoryId = '0192f6f8-743e-7c77-a349-cd07c3e8c002';
export const printerRuleId = '0192f6f8-743e-7c77-a349-cd07c3e8d001';
export const balanceRuleId = '0192f6f8-743e-7c77-a349-cd07c3e8d002';

export const categoriesFixture: NotificationCategory[] = [
  {
    id: serviceCategoryId,
    key: 'service',
    name: 'Service & safety',
    description: 'What people need to use the makerspace.',
    basis: 'required',
    textVersion: 1,
    textChangedAt: '2026-01-01T00:00:00Z',
    position: 0,
    ruleCount: 1,
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: newsCategoryId,
    key: null,
    name: 'News & events',
    description: 'Events and offers.',
    basis: 'consent',
    textVersion: 2,
    textChangedAt: '2026-02-01T00:00:00Z',
    position: 1,
    ruleCount: 1,
    version: 4,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-02-01T00:00:00Z',
  },
];

export const printerRule: NotificationRule = {
  id: printerRuleId,
  name: 'Printer error',
  description: 'Tell the supervisors when a printer fails.',
  categoryId: serviceCategoryId,
  enabled: true,
  mandatory: true,
  systemKey: 'printer_error',
  definition: {
    trigger: { type: 'event', event: 'printer_error' },
    loop: null,
    conditions: { mode: 'all', items: [] },
    actions: [
      {
        channel: 'in_app',
        delayMinutes: 0,
        recipients: ['machine_supervisors'],
        title: 'Error on {machine}',
        body: '',
        inApp: { appearance: 'toast', level: 'error', toastSeconds: 10, button: { kind: 'none' } },
      },
    ],
    escalation: {
      stopWhen: 'error_cleared',
      steps: [
        {
          after: { value: 20, unit: 'minutes' },
          action: { channel: 'email', recipients: ['machine_supervisors'], title: 'Still broken: {machine}' },
        },
      ],
    },
    throttle: null,
  },
  stats: null,
  warnings: [],
  lastFiredAt: '2026-03-01T10:00:00Z',
  version: 3,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-03-01T10:00:00Z',
};

export const balanceRule: NotificationRule = {
  id: balanceRuleId,
  name: 'Open balance reminder',
  description: 'Monthly reminder to people with an unpaid balance.',
  categoryId: newsCategoryId,
  enabled: false,
  mandatory: false,
  systemKey: null,
  definition: {
    trigger: { type: 'schedule', schedule: { repeat: 'monthly', dayOfMonth: 1, time: '09:00' } },
    loop: { collection: 'people', mode: 'each', filter: { mode: 'all', items: [] } },
    conditions: {
      mode: 'all',
      items: [{ field: 'i.unpaid', op: 'gt', value: 0 }],
    },
    actions: [
      {
        channel: 'email',
        delayMinutes: 0,
        recipients: ['item:self'],
        title: 'Your open balance',
        body: 'You owe {person.unpaid}.',
      },
    ],
    escalation: null,
    throttle: null,
  },
  stats: null,
  warnings: [],
  lastFiredAt: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
