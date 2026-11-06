import { describe, expect, it } from 'vitest';
import { balanceRule, catalogFixture, printerRule } from '../../test/notificationCenter';
import {
  blankDefinition,
  defaultCondition,
  fieldGroups,
  normalizeCondition,
  pruneDefinition,
  validateDraft,
  type RuleDraft,
} from './ruleModel';
import { fillPlaceholders, scheduleText, splitPlaceholders, summaryText } from './ruleText';

describe('summaryText', () => {
  it('describes an event rule with its action and escalation', () => {
    expect(summaryText(catalogFixture, printerRule.definition)).toBe(
      'When a printer reports an error: show an error pop-up for supervisors of the machine. Unless the error is cleared, after 20 min e-mail supervisors of the machine.',
    );
  });

  it('describes a looping schedule rule with its condition', () => {
    expect(summaryText(catalogFixture, balanceRule.definition)).toBe(
      'Monthly on day 1 at 09:00, for every person where unpaid amount is more than 0 €: e-mail the person itself.',
    );
  });

  it('says so while nothing is sent yet', () => {
    expect(summaryText(catalogFixture, blankDefinition(catalogFixture, 'manual'))).toBe(
      'When someone presses Run now: nothing is sent yet.',
    );
  });

  it('names roles and people from the lookup', () => {
    const definition = structuredClone(printerRule.definition);
    definition.actions[0].recipients = ['role:r1', 'person:p1'];
    expect(
      summaryText(catalogFixture, definition, { roles: { r1: 'Leitung' }, people: { p1: 'Jana Huber' } }),
    ).toContain('for everyone with the role Leitung and Jana Huber');
  });

  it('adds the throttle', () => {
    const definition = structuredClone(printerRule.definition);
    definition.throttle = { per: 'machine', every: { value: 1, unit: 'hours' } };
    expect(summaryText(catalogFixture, definition)).toContain('At most once per machine every 1 h.');
  });
});

describe('scheduleText', () => {
  it('formats every repeat', () => {
    expect(scheduleText({ repeat: 'daily', time: '08:30' })).toBe('Every day at 08:30');
    expect(scheduleText({ repeat: 'weekdays', time: '08:30' })).toBe('Weekdays at 08:30');
    expect(scheduleText({ repeat: 'weekly', weekdays: ['mon', 'thu'], time: '18:00' })).toBe('Every Mon, Thu at 18:00');
    expect(scheduleText({ repeat: 'before_open_day', hours: 2 })).toBe('2 h before each open day');
    expect(scheduleText({ repeat: 'after_open_day', hours: 1 })).toBe('1 h after each open day');
  });
});

describe('placeholders', () => {
  it('splits text and placeholders', () => {
    expect(splitPlaceholders('Error on {machine} at {person.name}!')).toEqual([
      { kind: 'text', value: 'Error on ' },
      { kind: 'placeholder', value: 'machine' },
      { kind: 'text', value: ' at ' },
      { kind: 'placeholder', value: 'person.name' },
      { kind: 'text', value: '!' },
    ]);
  });

  it('fills known examples and keeps unknown placeholders visible', () => {
    expect(fillPlaceholders('{machine} / {other}', new Map([['machine', 'H2D']]))).toBe('H2D / {other}');
  });
});

describe('conditions', () => {
  it('groups the fields of the rule context', () => {
    const groups = fieldGroups(catalogFixture, balanceRule.definition, 'if');
    expect(groups.map((group) => group.label)).toEqual(['This person', 'Each recipient', 'Now']);
    expect(groups[0].fields.map((f) => f.key)).toEqual(['i.name', 'i.unpaid']);
    expect(fieldGroups(catalogFixture, balanceRule.definition, 'filter')[0].label).toBe('Each person');
  });

  it('starts with a field of the rule, not of the recipient', () => {
    const condition = defaultCondition(fieldGroups(catalogFixture, printerRule.definition, 'if'));
    expect(condition).toMatchObject({ field: 'e.severity', op: 'gte', value: 'low' });
  });

  it('reshapes the value when the operator changes', () => {
    const weekday = catalogFixture.nowFields[0];
    expect(normalizeCondition(weekday, { field: 'n.weekday', op: 'any', value: 'mon' }).value).toEqual(['mon']);
    expect(normalizeCondition(weekday, { field: 'n.weekday', op: 'is', value: ['mon', 'tue'] }).value).toBe('mon');
    const unpaid = catalogFixture.collections[0].fields[1];
    expect(normalizeCondition(unpaid, { field: 'i.unpaid', op: 'between', value: 5 })).toMatchObject({
      value: 5,
      value2: 15,
    });
  });

  it('drops conditions and recipients the new context no longer offers', () => {
    const definition = structuredClone(balanceRule.definition);
    definition.loop = null;
    const pruned = pruneDefinition(catalogFixture, definition);
    expect(pruned.conditions.items).toEqual([]);
    expect(pruned.actions[0].recipients).toEqual([]);
  });
});

describe('validateDraft', () => {
  const draft = (overrides: Partial<RuleDraft> = {}): RuleDraft => ({
    name: 'Rule',
    description: '',
    categoryId: 'c',
    enabled: true,
    mandatory: false,
    definition: structuredClone(printerRule.definition),
    ...overrides,
  });

  it('accepts a complete rule', () => {
    expect(validateDraft(catalogFixture, draft())).toEqual([]);
  });

  it('lists what is missing', () => {
    const definition = blankDefinition(catalogFixture, 'event');
    expect(validateDraft(catalogFixture, draft({ name: ' ', categoryId: '', definition }))).toEqual([
      'Give the rule a name.',
      'Choose a category.',
      'Add at least one action under Then.',
    ]);
  });

  it('asks for a recipient and a title on every action', () => {
    const definition = structuredClone(printerRule.definition);
    definition.actions[0].recipients = [];
    definition.actions[0].title = '';
    expect(validateDraft(catalogFixture, draft({ definition }))).toEqual([
      'Then › In-app notification 1: add a recipient.',
      'Then › In-app notification 1: write a title.',
    ]);
  });
});
