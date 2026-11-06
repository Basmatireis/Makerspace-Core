import type { NotificationCatalog, NotificationCondition, NotificationConditionSet } from '../../api/generated/models';
import {
  conditionKeys,
  fieldGroups,
  fieldMap,
  newAction,
  type Action,
  type RuleDraft,
} from '../notificationcenter/ruleModel';

export type Starter = {
  key: string;
  name: string;
  description: string;
  /** The area of the app the subscription watches. */
  area: string;
  draft: RuleDraft;
};

const condition = (field: string, op: string, value?: unknown): NotificationCondition =>
  value === undefined ? { field, op } : { field, op, value, ref: null };
const all = (...items: NotificationCondition[]): NotificationConditionSet => ({ mode: 'all', items });

function message(channel: 'in_app' | 'email', title: string, body: string): Action {
  return { ...newAction(channel, true), title, body };
}

function draft(name: string, definition: Omit<RuleDraft['definition'], 'escalation' | 'throttle'>): RuleDraft {
  return {
    name,
    description: '',
    categoryId: '',
    enabled: true,
    mandatory: false,
    definition: { ...definition, escalation: null, throttle: null },
  };
}

/** Whether everything the subscription refers to exists in the catalog this person may use. */
function fits(catalog: NotificationCatalog, candidate: RuleDraft): boolean {
  const { definition } = candidate;
  const { trigger, loop } = definition;
  if (trigger.type === 'event' && !catalog.triggers.some((entry) => entry.key === trigger.event)) return false;
  if (loop && !catalog.collections.some((entry) => entry.key === loop.collection)) return false;
  const known = fieldMap(fieldGroups(catalog, definition, 'if', true));
  const filterKeys = fieldMap(fieldGroups(catalog, definition, 'filter', true));
  return (
    conditionKeys(definition.conditions).every((key) => known.has(key)) &&
    (!loop || conditionKeys(loop.filter).every((key) => filterKeys.has(key)))
  );
}

/** Ready-made subscriptions; only those the live catalog supports are offered, and each opens in the editor. */
export function startersFor(catalog: NotificationCatalog): Starter[] {
  const machine = catalog.triggers
    .find((entry) => entry.key === 'run_finished')
    ?.fields.find((field) => field.key === 'machine')?.options[0]?.value;
  const candidates: Starter[] = [
    {
      key: 'machine-free',
      name: 'When a machine is free',
      description: 'Hear when a run on a machine you wait for ends. Pick the machine in the editor.',
      area: 'Workshop',
      draft: draft('When a machine is free', {
        trigger: { type: 'event', event: 'run_finished' },
        loop: null,
        conditions: all(...(machine ? [condition('e.machine', 'is', machine)] : [])),
        actions: [message('in_app', '{machine} is free', '{job} just finished.')],
      }),
    },
    {
      key: 'open-days-below-minimum',
      name: "Free open days while I'm below my minimum",
      description: 'A weekly list of open days with free places, only until you reached your minimum.',
      area: 'Open Days',
      draft: draft('Free open days while I am below my minimum', {
        trigger: { type: 'schedule', schedule: { repeat: 'weekly', weekdays: ['mon'], time: '08:00' } },
        loop: {
          collection: 'open_days',
          mode: 'summary',
          filter: all(condition('i.startsIn', 'lte', 14), condition('i.free', 'gt', 0)),
        },
        conditions: all(condition('s.count', 'gt', 0), condition('r.belowMinimum', 'yes')),
        actions: [message('email', '{count} open days with free places', '{list}')],
      }),
    },
    {
      key: 'spools-low',
      name: 'Spools running low',
      description: 'A weekly list of spools under a weight you choose.',
      area: 'Inventory',
      draft: draft('Spools running low', {
        trigger: { type: 'schedule', schedule: { repeat: 'weekly', weekdays: ['fri'], time: '12:00' } },
        loop: { collection: 'spools', mode: 'summary', filter: all(condition('i.remaining', 'lt', 150)) },
        conditions: all(condition('s.count', 'gt', 0)),
        actions: [message('email', '{count} spools are running low', '{list}')],
      }),
    },
    {
      key: 'before-my-open-day',
      name: 'Remind me before my open day',
      description: 'A message a few hours before each day you are signed up for.',
      area: 'Open Days',
      draft: draft('Open day reminder', {
        trigger: { type: 'schedule', schedule: { repeat: 'before_open_day', hours: 3 } },
        loop: null,
        conditions: all(condition('e.mine', 'yes')),
        actions: [message('in_app', 'Open day in 3 hours', '{day}, {time}. {supervisors} supervisor(s) signed up.')],
      }),
    },
  ];
  return candidates.filter((starter) => fits(catalog, starter.draft));
}
