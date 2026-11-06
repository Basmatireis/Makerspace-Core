import type {
  NotificationCatalog,
  NotificationCondition,
  NotificationConditionItem,
  NotificationConditionSet,
  NotificationRuleSchedule,
} from '../../api/generated/models';
import {
  allFields,
  contextOf,
  delayOptions,
  operatorsFor,
  recipientGroups,
  throttleChoices,
  type Action,
  type Definition,
} from './ruleModel';

/** Names of the things a rule refers to by id. */
export type NameLookup = {
  roles: Record<string, string>;
  people: Record<string, string>;
};

export const emptyLookup: NameLookup = { roles: {}, people: {} };

const lower = (text: string) =>
  text.length > 1 && text[1] === text[1].toLowerCase() ? text[0].toLowerCase() + text.slice(1) : text;

export function joinList(items: string[], word = 'and'): string {
  if (items.length < 2) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
}

export function durationText(value: number, unit: string): string {
  return `${value} ${unit === 'minutes' ? 'min' : unit === 'hours' ? 'h' : value === 1 ? 'day' : 'days'}`;
}

export function scheduleText(schedule: NotificationRuleSchedule | undefined): string {
  if (!schedule) return '';
  const at = schedule.time ? ` at ${schedule.time}` : '';
  switch (schedule.repeat) {
    case 'daily':
      return `Every day${at}`;
    case 'weekdays':
      return `Weekdays${at}`;
    case 'weekly': {
      const days = (schedule.weekdays ?? []).map((day) => day[0].toUpperCase() + day.slice(1));
      return `Every ${days.length ? days.join(', ') : '(no day)'}${at}`;
    }
    case 'monthly':
      return `Monthly on day ${schedule.dayOfMonth ?? 1}${at}`;
    case 'before_open_day':
      return `${schedule.hours ?? 0} h before each open day`;
    case 'after_open_day':
      return `${schedule.hours ?? 0} h after each open day`;
    default:
      return schedule.repeat;
  }
}

export function triggerLabel(catalog: NotificationCatalog | undefined, definition: Definition): string {
  const { trigger } = definition;
  if (trigger.type === 'manual') return 'When someone presses Run now';
  if (trigger.type === 'schedule') return scheduleText(trigger.schedule);
  return catalog?.triggers.find((candidate) => candidate.key === trigger.event)?.label ?? trigger.event ?? '';
}

export function recipientLabel(
  key: string,
  catalog: NotificationCatalog | undefined,
  definition: Definition,
  lookup: NameLookup,
): string {
  if (key === 'me') return 'You';
  if (key.startsWith('role:')) return lookup.roles[key.slice(5)] ?? 'A role';
  if (key.startsWith('person:')) return lookup.people[key.slice(7)] ?? 'A person';
  const dynamic = catalog ? recipientGroups(catalog, definition).flatMap((group) => group.choices) : [];
  return dynamic.find((choice) => choice.key === key)?.label ?? key.replace('item:', '');
}

function recipientPhrase(key: string, catalog: NotificationCatalog, definition: Definition, lookup: NameLookup) {
  if (key.startsWith('role:')) return `everyone with the role ${lookup.roles[key.slice(5)] ?? 'selected'}`;
  const label = recipientLabel(key, catalog, definition, lookup);
  return key.startsWith('person:') ? label : lower(label);
}

function conditionText(catalog: NotificationCatalog, definition: Definition, item: NotificationConditionItem): string {
  if (item.group) {
    const inner = item.group.items.map((c) => conditionText(catalog, definition, c)).filter(Boolean);
    return `(${inner.join(item.group.mode === 'all' ? ' and ' : ' or ')})`;
  }
  const c = item as NotificationCondition;
  const fields = allFields(catalog, definition);
  const field = fields.get(c.field);
  if (!field) return '';
  const op = (operatorsFor(field.type).find((o) => o.value === c.op) ?? operatorsFor(field.type)[0]).label;
  const own = c.field.startsWith('r.') ? "the recipient's " : '';
  const who = c.field.startsWith('r.') ? 'the recipient is ' : '';
  const label = `${own}${lower(field.label)}`;
  if (field.type === 'bool') {
    if (who) return c.op === 'yes' ? `${who}${lower(field.label)}` : `${who}not ${lower(field.label)}`;
    return c.op === 'yes' ? label : `not ${label}`;
  }
  if (c.op === 'empty' || c.op === 'notempty') return `${label} ${op}`;
  const ref = c.ref ? fields.get(c.ref) : undefined;
  if (ref) return `${label} ${op} ${c.ref!.startsWith('r.') ? 'their ' : ''}${lower(ref.label)}`;
  const optionLabel = (value: unknown) => field.options.find((o) => o.value === value)?.label ?? String(value);
  const unit = field.unit ? ` ${field.unit}` : '';
  if (c.op === 'between') return `${label} is between ${String(c.value ?? 0)} and ${String(c.value2 ?? '')}${unit}`;
  const raw = Array.isArray(c.value) ? joinList((c.value as unknown[]).map(optionLabel), 'or') : optionLabel(c.value);
  const value = field.type === 'text' ? `“${raw}”` : `${raw}${field.type === 'number' ? unit : ''}`;
  return `${label} ${op} ${value}`;
}

function setText(catalog: NotificationCatalog, definition: Definition, set: NotificationConditionSet): string[] {
  return set.items.map((item) => conditionText(catalog, definition, item)).filter(Boolean);
}

const phrases: Record<string, { verb: string; thing: string }> = {
  bell: { verb: 'quietly add', thing: 'bell notification' },
  toast: { verb: 'show', thing: 'pop-up' },
  banner: { verb: 'show', thing: 'banner' },
  dialog: { verb: 'open', thing: 'dialog' },
};

const withArticle = (adjective: string, thing: string) => {
  const first = adjective || thing;
  return `${/^[aeiou]/i.test(first) ? 'an' : 'a'} ${adjective ? `${adjective} ` : ''}${thing}`;
};

function actionText(catalog: NotificationCatalog, definition: Definition, action: Action, lookup: NameLookup): string {
  const who =
    joinList(action.recipients.map((key) => recipientPhrase(key, catalog, definition, lookup))) || 'nobody yet';
  const delay = delayOptions.find((option) => option.value === action.delayMinutes);
  const when = action.delayMinutes && delay ? ` ${delay.label.toLowerCase()}` : '';
  if (action.channel === 'in_app') {
    const options = action.inApp;
    const button = options?.button?.kind && options.button.kind !== 'none' ? options.button : undefined;
    const buttonText = button
      ? ` with “${button.label || (button.kind === 'acknowledge' ? 'Acknowledge' : button.kind === 'ok' ? 'OK' : 'Open')}”`
      : '';
    const closes =
      options?.onlyButtonCloses && button && (options.appearance === 'banner' || options.appearance === 'dialog')
        ? ' that only the button closes'
        : '';
    const level = options?.level && options.level !== 'info' ? options.level : '';
    const phrase = phrases[options?.appearance ?? 'toast'] ?? phrases.toast;
    const fallback = options?.emailFallbackMinutes
      ? ` (by e-mail instead if it hasn't reached them after ${options.emailFallbackMinutes} min)`
      : '';
    return `${phrase.verb} ${withArticle(level, phrase.thing)}${buttonText}${closes} for ${who}${when}${options?.onlineOnly ? ' if they have it open' : ''}${fallback}`;
  }
  if (action.channel === 'email') return `e-mail ${who}${when}`;
  if (action.channel === 'signage') {
    const count = action.signage?.displayIds.length ?? 0;
    return `show a ${action.signage?.tone ?? 'info'} notice on ${count ? `${count} display${count === 1 ? '' : 's'}` : 'no display'} for ${action.signage?.durationMinutes ?? 0} min${when}`;
  }
  const devices = action.tablet?.deviceIds.length ?? 0;
  const mode = action.tablet?.mode;
  const tail =
    mode === 'person_checkin'
      ? ' to the person who checked in'
      : mode === 'next_checkin'
        ? ' at their next check-in'
        : mode === 'everyone_today'
          ? ' to everyone checking in today'
          : '';
  return `show a notice on ${devices ? `${devices} tablet${devices === 1 ? '' : 's'}` : 'no tablet'}${tail}${when}`;
}

/** The "In plain words" sentence for the editor's preview column. */
export function summaryText(
  catalog: NotificationCatalog,
  definition: Definition,
  lookup: NameLookup = emptyLookup,
): string {
  const ctx = contextOf(catalog, definition);
  const { trigger } = definition;
  let text =
    trigger.type === 'event' ? `When ${lower(triggerLabel(catalog, definition))}` : triggerLabel(catalog, definition);
  if (ctx.collection && ctx.eachMode) text += `, for every ${ctx.collection.one}`;
  if (ctx.collection && ctx.summaryMode && definition.loop) {
    const filter = setText(catalog, definition, definition.loop.filter);
    const joiner = definition.loop.filter.mode === 'all' ? ' and ' : ' or ';
    text += `, count the ${ctx.collection.plural}${filter.length ? ` where ${filter.join(joiner)}` : ''}`;
  }
  const conditions = setText(catalog, definition, definition.conditions);
  if (conditions.length) {
    text += `${ctx.eachMode ? ' where' : ' and if'} ${conditions.join(definition.conditions.mode === 'all' ? ' and ' : ' or ')}`;
  }
  text += `: ${
    definition.actions.length
      ? joinList(definition.actions.map((action) => actionText(catalog, definition, action, lookup)))
      : 'nothing is sent yet'
  }.`;
  const escalation = definition.escalation;
  if (escalation?.steps.length) {
    const stop = lower(
      (
        [...(ctx.trigger?.resolutions ?? []), ...catalog.resolutions].find((r) => r.key === escalation.stopWhen) ?? {
          label: escalation.stopWhen,
        }
      ).label,
    );
    text += ` Unless ${stop}, ${escalation.steps
      .map(
        (step) =>
          `after ${durationText(step.after.value, step.after.unit)} ${actionText(catalog, definition, step.action, lookup)}`,
      )
      .join(', then ')}.`;
  }
  if (definition.throttle) {
    const per =
      throttleChoices(catalog, definition).find((c) => c.key === definition.throttle!.per)?.label ?? 'this rule';
    text += ` At most once per ${per.replace(/^each /, '')} every ${durationText(definition.throttle.every.value, definition.throttle.every.unit)}.`;
  }
  return text;
}

export type TextPart = { kind: 'text' | 'placeholder'; value: string };

/** Splits a message into plain text and `{placeholder}` parts. */
export function splitPlaceholders(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const pattern = /\{([a-zA-Z0-9_.]+)\}/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push({ kind: 'text', value: text.slice(last, match.index) });
    parts.push({ kind: 'placeholder', value: match[1] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) });
  return parts;
}

/** A message as plain text, with the catalog's example value where one is known. */
export function fillPlaceholders(text: string, examples: Map<string, string>): string {
  return splitPlaceholders(text)
    .map((part) => (part.kind === 'text' ? part.value : examples.get(part.value) || `{${part.value}}`))
    .join('');
}
