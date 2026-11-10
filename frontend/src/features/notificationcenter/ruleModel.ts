import type {
  NotificationCatalog,
  NotificationCatalogChoice,
  NotificationCatalogCollection,
  NotificationCatalogField,
  NotificationCatalogPlaceholder,
  NotificationCatalogTrigger,
  NotificationCondition,
  NotificationConditionItem,
  NotificationConditionSet,
  NotificationRule,
  NotificationRuleAction,
  NotificationRuleDefinition,
  NotificationRuleInput,
} from '../../api/generated/models';

export type Definition = NotificationRuleDefinition;
export type Action = NotificationRuleAction;
export type Channel = 'in_app' | 'email' | 'signage' | 'tablet';
export type RuleKind = 'event' | 'schedule' | 'loop' | 'manual';

/** What the editor form holds; the definition is replaced as a whole on every change. */
export type RuleDraft = {
  name: string;
  description: string;
  categoryId: string;
  enabled: boolean;
  mandatory: boolean;
  definition: Definition;
};

export const channels: readonly { id: Channel; label: string; short: string }[] = [
  { id: 'in_app', label: 'In-app notification', short: 'In-app' },
  { id: 'email', label: 'E-mail', short: 'E-mail' },
  { id: 'signage', label: 'Signage notice', short: 'Signage' },
  { id: 'tablet', label: 'Tablet notice', short: 'Tablet' },
];

export const channelLabel = (id: string) => channels.find((channel) => channel.id === id)?.label ?? id;
export const channelShort = (id: string) => channels.find((channel) => channel.id === id)?.short ?? id;

export const weekdays = [
  { value: 'mon', label: 'Mon' },
  { value: 'tue', label: 'Tue' },
  { value: 'wed', label: 'Wed' },
  { value: 'thu', label: 'Thu' },
  { value: 'fri', label: 'Fri' },
  { value: 'sat', label: 'Sat' },
  { value: 'sun', label: 'Sun' },
] as const;

export const delayOptions = [
  { value: 0, label: 'Immediately' },
  { value: 5, label: 'After 5 min' },
  { value: 15, label: 'After 15 min' },
  { value: 30, label: 'After 30 min' },
  { value: 60, label: 'After 1 h' },
  { value: 240, label: 'After 4 h' },
  { value: 1440, label: 'After 1 day' },
] as const;

export const durationUnits = [
  { value: 'minutes', label: 'minutes' },
  { value: 'hours', label: 'hours' },
  { value: 'days', label: 'days' },
] as const;

export const appearances = [
  { value: 'bell', label: 'Bell only', help: 'Only the badge on the bell. Nothing pops up.' },
  { value: 'toast', label: 'Pop-up', help: 'Top right, disappears after a while.' },
  { value: 'banner', label: 'Banner', help: 'Across the top of every page until it is closed.' },
  { value: 'dialog', label: 'Dialog', help: 'In the middle of the screen. People must react before they continue.' },
] as const;

export const levels = [
  { value: 'info', label: 'Info' },
  { value: 'success', label: 'Success' },
  { value: 'warning', label: 'Warning' },
  { value: 'error', label: 'Error' },
] as const;

export const buttonKinds = [
  { value: 'none', label: 'No button' },
  { value: 'ok', label: 'OK' },
  { value: 'acknowledge', label: 'Acknowledge (stops the escalation)' },
  { value: 'link', label: 'Button that opens a page' },
] as const;

export const tabletModes = [
  { value: 'banner', label: 'As a banner on the start screen' },
  { value: 'person_checkin', label: 'To the person, right after check-in' },
  { value: 'next_checkin', label: 'To this person at their next check-in' },
  { value: 'everyone_today', label: 'To everyone who checks in today' },
] as const;

export const signageTones = [
  { value: 'info', label: 'Info (blue)' },
  { value: 'warning', label: 'Warning (yellow)' },
  { value: 'critical', label: 'Critical (red)' },
] as const;

export const toastSecondsOptions = [
  { value: 5, label: '5 seconds' },
  { value: 10, label: '10 seconds' },
  { value: 30, label: '30 seconds' },
  { value: 0, label: 'until it is closed' },
] as const;

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/* ---------- catalog access ---------- */

export type FieldGroup = { id: string; label: string; fields: NotificationCatalogField[] };

export type RuleContext = {
  trigger?: NotificationCatalogTrigger;
  openDay: boolean;
  collection?: NotificationCatalogCollection;
  eachMode: boolean;
  summaryMode: boolean;
};

export function contextOf(catalog: NotificationCatalog, definition: Definition): RuleContext {
  const { trigger: t, loop } = definition;
  const repeat = t.schedule?.repeat;
  const collection = loop ? catalog.collections.find((candidate) => candidate.key === loop.collection) : undefined;
  return {
    trigger: t.type === 'event' ? catalog.triggers.find((candidate) => candidate.key === t.event) : undefined,
    openDay: t.type === 'schedule' && (repeat === 'before_open_day' || repeat === 'after_open_day'),
    collection,
    eachMode: Boolean(collection && loop?.mode === 'each'),
    summaryMode: Boolean(collection && loop?.mode === 'summary'),
  };
}

const prefixed = (prefix: string, fields: NotificationCatalogField[]) =>
  fields.map((field) => ({ ...field, key: prefix + field.key }));

export function fieldGroups(
  catalog: NotificationCatalog,
  definition: Definition,
  where: 'if' | 'filter',
  /** A personal subscription's recipient is its owner, so the recipient facts are "You". */
  personal = false,
): FieldGroup[] {
  const ctx = contextOf(catalog, definition);
  if (where === 'filter') {
    return ctx.collection
      ? [{ id: 'item', label: `Each ${ctx.collection.one}`, fields: prefixed('i.', ctx.collection.fields) }]
      : [];
  }
  const groups: FieldGroup[] = [];
  if (ctx.trigger?.fields.length)
    groups.push({ id: 'event', label: 'Event', fields: prefixed('e.', ctx.trigger.fields) });
  if (ctx.openDay) groups.push({ id: 'event', label: 'This open day', fields: prefixed('e.', catalog.openDay.fields) });
  if (ctx.collection && ctx.eachMode) {
    groups.push({ id: 'item', label: `This ${ctx.collection.one}`, fields: prefixed('i.', ctx.collection.fields) });
  }
  if (ctx.collection && ctx.summaryMode) {
    groups.push({ id: 'summary', label: 'Summary', fields: prefixed('s.', ctx.collection.summaryFields) });
  }
  groups.push({
    id: 'recipient',
    label: personal ? 'You' : 'Each recipient',
    fields: prefixed('r.', catalog.recipientFields),
  });
  groups.push({ id: 'now', label: 'Now', fields: prefixed('n.', catalog.nowFields) });
  return groups;
}

export const fieldMap = (groups: FieldGroup[]): Map<string, NotificationCatalogField> =>
  new Map(groups.flatMap((group) => group.fields.map((field) => [field.key, field] as const)));

export function allFields(catalog: NotificationCatalog, definition: Definition) {
  return fieldMap([...fieldGroups(catalog, definition, 'if'), ...fieldGroups(catalog, definition, 'filter')]);
}

export type RecipientGroup = { label: string; choices: NotificationCatalogChoice[] };

/** Dynamic recipients the rule's context offers; keys are final (`item:` prefixed where needed). */
export function recipientGroups(catalog: NotificationCatalog, definition: Definition): RecipientGroup[] {
  const ctx = contextOf(catalog, definition);
  const groups: RecipientGroup[] = [];
  if (ctx.collection && ctx.eachMode && ctx.collection.recipients.length) {
    groups.push({
      label: `From each ${ctx.collection.one}`,
      choices: ctx.collection.recipients.map((choice) => ({ key: `item:${choice.key}`, label: choice.label })),
    });
  }
  const own = ctx.trigger?.recipients ?? (ctx.openDay ? catalog.openDay.recipients : []);
  if (own.length) groups.push({ label: ctx.openDay ? 'From the open day' : 'From the event', choices: own });
  return groups;
}

export function placeholderChoices(
  catalog: NotificationCatalog,
  definition: Definition,
): NotificationCatalogPlaceholder[] {
  const ctx = contextOf(catalog, definition);
  const out: NotificationCatalogPlaceholder[] = [];
  if (ctx.trigger) out.push(...ctx.trigger.placeholders);
  if (ctx.openDay) out.push(...catalog.openDay.placeholders);
  if (ctx.collection && ctx.eachMode) {
    out.push(
      ...ctx.collection.fields.map((field) => ({
        key: `${ctx.collection!.placeholderPrefix}.${field.key}`,
        label: `${ctx.collection!.one} · ${field.label}`,
        example: field.options[0]?.label ?? '',
      })),
    );
  }
  if (ctx.collection && ctx.summaryMode) {
    out.push({ key: 'list', label: `List of ${ctx.collection.plural}`, example: '' });
    out.push(
      ...ctx.collection.summaryFields.map((field) => ({
        key: field.key,
        label: field.label,
        example: '',
      })),
    );
  }
  if (!out.some((placeholder) => placeholder.key === 'link')) {
    out.push({ key: 'link', label: 'Link to the details', example: '/' });
  }
  return out.filter((placeholder, index) => out.findIndex((other) => other.key === placeholder.key) === index);
}

export function resolutionChoices(catalog: NotificationCatalog, definition: Definition): NotificationCatalogChoice[] {
  const ctx = contextOf(catalog, definition);
  const out = [...(ctx.trigger?.resolutions ?? []), ...catalog.resolutions];
  if (ctx.collection && ctx.eachMode) {
    out.unshift({ key: 'item_no_longer_matches', label: `This ${ctx.collection.one} no longer matches` });
  }
  return out.filter((choice, index) => out.findIndex((other) => other.key === choice.key) === index);
}

export function throttleChoices(catalog: NotificationCatalog, definition: Definition): NotificationCatalogChoice[] {
  const ctx = contextOf(catalog, definition);
  const out: NotificationCatalogChoice[] = [
    { key: 'rule', label: 'this rule' },
    { key: 'person', label: 'each person' },
    ...(ctx.trigger?.throttleSubjects ?? []),
  ];
  if (ctx.collection && ctx.eachMode) out.push({ key: 'item', label: `each ${ctx.collection.one}` });
  return out;
}

/* ---------- conditions ---------- */

export const operatorsFor = (type: string): { value: string; label: string }[] => {
  switch (type) {
    case 'enum':
      return [
        { value: 'is', label: 'is' },
        { value: 'not', label: 'is not' },
        { value: 'any', label: 'is any of' },
        { value: 'none', label: 'is none of' },
      ];
    case 'ordered':
      return [
        { value: 'gte', label: 'is at least' },
        { value: 'lte', label: 'is at most' },
        { value: 'is', label: 'is' },
        { value: 'not', label: 'is not' },
      ];
    case 'number':
      return [
        { value: 'gt', label: 'is more than' },
        { value: 'gte', label: 'is at least' },
        { value: 'lt', label: 'is less than' },
        { value: 'lte', label: 'is at most' },
        { value: 'eq', label: 'is' },
        { value: 'between', label: 'is between' },
      ];
    case 'text':
      return [
        { value: 'contains', label: 'contains' },
        { value: 'notcontains', label: "doesn't contain" },
        { value: 'eq', label: 'is' },
        { value: 'starts', label: 'starts with' },
        { value: 'empty', label: 'is empty' },
        { value: 'notempty', label: 'is not empty' },
      ];
    case 'bool':
      return [
        { value: 'yes', label: 'is true' },
        { value: 'no', label: 'is false' },
      ];
    default:
      return [
        { value: 'includes', label: 'includes' },
        { value: 'excludes', label: "doesn't include" },
      ];
  }
};

export const isMultiOp = (op: string) => op === 'any' || op === 'none';
export const isLeaf = (item: NotificationConditionItem) => item.group === undefined;

function defaultValue(field: NotificationCatalogField, op: string): unknown {
  switch (field.type) {
    case 'enum':
    case 'ordered':
    case 'list': {
      const first = field.options[0]?.value ?? '';
      return isMultiOp(op) ? [first] : first;
    }
    case 'number':
      return 0;
    case 'text':
      return '';
    default:
      return undefined;
  }
}

/** A well-formed condition for the field: operator valid for its type, value shaped for the operator. */
export function normalizeCondition(
  field: NotificationCatalogField,
  condition: NotificationCondition,
): NotificationCondition {
  const ops = operatorsFor(field.type);
  const op = ops.some((candidate) => candidate.value === condition.op) ? condition.op : ops[0].value;
  const next: NotificationCondition = { field: condition.field, op };
  if (field.type === 'bool') return next;
  if (field.type === 'number') {
    if (op === 'between') {
      const low = typeof condition.value === 'number' ? condition.value : 0;
      return { ...next, value: low, value2: condition.value2 ?? low + 10 };
    }
    if (op === 'empty') return next;
    return { ...next, value: typeof condition.value === 'number' ? condition.value : 0, ref: condition.ref ?? null };
  }
  if (op === 'empty' || op === 'notempty') return next;
  const value = condition.value;
  if (isMultiOp(op)) {
    const list = Array.isArray(value)
      ? (value as string[])
      : value
        ? [String(value)]
        : [String(defaultValue(field, 'is'))];
    return { ...next, value: list };
  }
  const single = Array.isArray(value) ? String((value as string[])[0] ?? '') : (value ?? defaultValue(field, op));
  return { ...next, value: single };
}

export function defaultCondition(groups: FieldGroup[]): NotificationCondition | null {
  const preferred =
    groups.find((group) => group.id !== 'recipient' && group.id !== 'now' && group.fields.length) ?? groups[0];
  const field = preferred?.fields[0];
  if (!field) return null;
  const op = operatorsFor(field.type)[0].value;
  return normalizeCondition(field, { field: field.key, op, value: defaultValue(field, op) });
}

export const emptySet = (): NotificationConditionSet => ({ mode: 'all', items: [] });

const leaves = (set: NotificationConditionSet): NotificationCondition[] =>
  set.items.flatMap((item) => (item.group ? item.group.items : [item as NotificationCondition]));

export function conditionKeys(set: NotificationConditionSet): string[] {
  return leaves(set).flatMap((condition) => [condition.field, ...(condition.ref ? [condition.ref] : [])]);
}

function pruneSet(set: NotificationConditionSet, allowed: Set<string>): NotificationConditionSet {
  const valid = (c: NotificationCondition) => allowed.has(c.field) && (!c.ref || allowed.has(c.ref));
  const items: NotificationConditionItem[] = [];
  for (const item of set.items) {
    if (item.group) {
      const kept = item.group.items.filter(valid);
      if (kept.length) items.push({ group: { ...item.group, items: kept } });
    } else if (valid(item as NotificationCondition)) {
      items.push(item);
    }
  }
  return { ...set, items };
}

/** Drops everything that no longer fits after the trigger or the loop changed. */
export function pruneDefinition(catalog: NotificationCatalog, definition: Definition): Definition {
  const next = clone(definition);
  // Machine scope exists only for triggers whose events concern one machine each.
  if (!contextOf(catalog, next).trigger?.machineScope) delete next.trigger.machines;
  const ifKeys = new Set(fieldGroups(catalog, next, 'if').flatMap((group) => group.fields.map((f) => f.key)));
  const filterKeys = new Set(fieldGroups(catalog, next, 'filter').flatMap((group) => group.fields.map((f) => f.key)));
  next.conditions = pruneSet(next.conditions, ifKeys);
  if (next.loop) next.loop = { ...next.loop, filter: pruneSet(next.loop.filter, filterKeys) };
  const dynamic = new Set(recipientGroups(catalog, next).flatMap((group) => group.choices.map((c) => c.key)));
  const fixRecipients = (action: Action) => ({
    ...action,
    recipients: action.recipients.filter(
      (key) => key === 'me' || key.startsWith('role:') || key.startsWith('person:') || dynamic.has(key),
    ),
  });
  next.actions = next.actions.map(fixRecipients);
  if (next.escalation) {
    const resolutions = resolutionChoices(catalog, next);
    next.escalation = {
      stopWhen: resolutions.some((r) => r.key === next.escalation!.stopWhen)
        ? next.escalation.stopWhen
        : (resolutions[0]?.key ?? ''),
      steps: next.escalation.steps.map((step) => ({ ...step, action: fixRecipients(step.action) })),
    };
  }
  if (next.throttle && !throttleChoices(catalog, next).some((choice) => choice.key === next.throttle!.per)) {
    next.throttle = { ...next.throttle, per: 'rule' };
  }
  return next;
}

/* ---------- actions and drafts ---------- */

/** Channels a personal subscription may use; signage and tablets address displays, not a person. */
export const personalChannels: readonly Channel[] = ['in_app', 'email'];

export function newAction(channel: Channel, personal = false): Action {
  const base = { recipients: personal ? ['me'] : [], title: '', body: '', delayMinutes: 0 };
  switch (channel) {
    case 'in_app':
      return {
        ...base,
        channel,
        inApp: {
          appearance: 'toast',
          level: 'info',
          toastSeconds: 10,
          button: { kind: 'none' },
          onlyButtonCloses: false,
          allowLater: false,
          onlineOnly: false,
          emailFallbackMinutes: null,
        },
      };
    case 'email':
      return { ...base, channel };
    case 'signage':
      return { ...base, channel, signage: { displayIds: [], durationMinutes: 15, tone: 'warning' } };
    default:
      return { ...base, channel, tablet: { deviceIds: [], mode: 'banner', mustTap: true } };
  }
}

export function blankDefinition(catalog: NotificationCatalog, kind: RuleKind): Definition {
  const base = { loop: null, conditions: emptySet(), actions: [], escalation: null, throttle: null };
  if (kind === 'event') {
    return { ...base, trigger: { type: 'event', event: catalog.triggers[0]?.key ?? '' } };
  }
  if (kind === 'manual') return { ...base, trigger: { type: 'manual' } };
  const trigger = { type: 'schedule', schedule: { repeat: 'daily', time: '09:00' } };
  if (kind === 'schedule') return { ...base, trigger };
  const collection = catalog.collections.find((candidate) => candidate.key === 'people') ?? catalog.collections[0];
  return { ...base, trigger, loop: { collection: collection?.key ?? '', mode: 'each', filter: emptySet() } };
}

export function draftFromRule(rule: NotificationRule): RuleDraft {
  return {
    name: rule.name,
    description: rule.description,
    categoryId: rule.categoryId ?? '',
    enabled: rule.enabled,
    mandatory: rule.mandatory,
    definition: clone(rule.definition),
  };
}

export const kindOf = (definition: Definition): RuleKind =>
  definition.trigger.type === 'event' ? 'event' : definition.trigger.type === 'manual' ? 'manual' : 'schedule';

/** The request body: no empty optional values the API would reject. */
export function toInput(draft: RuleDraft): NotificationRuleInput {
  const definition = clone(draft.definition);
  if (!definition.escalation?.steps.length && definition.escalation) definition.escalation = null;
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    categoryId: draft.categoryId || null,
    enabled: draft.enabled,
    mandatory: draft.mandatory,
    definition,
  };
}

/** Problems found before sending; the server validates again and has the last word. */
export const machinesMissingProblem = 'Choose at least one machine, or switch to All machines.';

export function validateDraft(
  catalog: NotificationCatalog,
  draft: RuleDraft,
  personal = false,
  /** "Selected machines" is chosen but no machine is. */
  machinesMissing = false,
): string[] {
  const problems: string[] = [];
  const { definition } = draft;
  const ctx = contextOf(catalog, definition);
  if (!draft.name.trim()) problems.push(personal ? 'Give the subscription a name.' : 'Give the rule a name.');
  if (!personal && !draft.categoryId) problems.push('Choose a category.');
  if (machinesMissing) problems.push(machinesMissingProblem);
  if (!definition.actions.length) problems.push('Add at least one action under Then.');
  const check = (action: Action, where: string) => {
    // A subscription always notifies its owner, so there is nothing to choose.
    if (!personal && (action.channel === 'in_app' || action.channel === 'email') && !action.recipients.length) {
      problems.push(`${where}: add a recipient.`);
    }
    if (action.channel === 'signage' && !action.signage?.displayIds.length)
      problems.push(`${where}: choose a display.`);
    if (action.channel === 'tablet' && !action.tablet?.deviceIds.length) problems.push(`${where}: choose a tablet.`);
    if (!action.title.trim()) problems.push(`${where}: write a ${action.channel === 'email' ? 'subject' : 'title'}.`);
  };
  definition.actions.forEach((action, index) => check(action, `Then › ${channelLabel(action.channel)} ${index + 1}`));
  if (definition.escalation) {
    if (!definition.escalation.steps.length) problems.push('Escalation is on but has no step.');
    definition.escalation.steps.forEach((step, index) => check(step.action, `Escalation step ${index + 1}`));
  }
  const schedule = definition.trigger.schedule;
  if (definition.trigger.type === 'schedule' && schedule?.repeat === 'weekly' && !schedule.weekdays?.length) {
    problems.push('Pick at least one weekday.');
  }
  if (
    !personal &&
    ctx.collection &&
    ctx.eachMode &&
    definition.actions.some(
      (a) =>
        (a.channel === 'in_app' || a.channel === 'email') &&
        a.recipients.length > 0 &&
        !a.recipients.some((key) => key.startsWith('item:')),
    )
  ) {
    problems.push(
      `For each is on, but an action goes to nobody from the ${ctx.collection.one}. Everyone would get one message per ${ctx.collection.one}; use a summary instead, or add a recipient from the ${ctx.collection.one}.`,
    );
  }
  return problems;
}

export const collectionOf = (catalog: NotificationCatalog, definition: Definition) =>
  contextOf(catalog, definition).collection;
