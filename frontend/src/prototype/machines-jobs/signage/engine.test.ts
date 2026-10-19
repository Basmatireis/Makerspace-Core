import { describe, expect, it } from 'vitest';
import { activeAnnouncementsFor, describeCondition, describeDays, fieldKeyFor, renderAnnouncement, resolvePlayback, timeWindowActive, unknownPlaceholders } from './engine';
import type { Announcement, AnnouncementTemplate, Condition, Rule, Sim } from './types';

const idle: Sim = { h2d: 'idle', x1c: 'idle', coreReachable: true };
const display = { defaultPlaylistId: 'pl-ads' };
// 2026-10-19 is a Monday.
const monday = (hours: number, minutes = 0) => new Date(2026, 9, 19, hours, minutes);
const saturday = (hours: number, minutes = 0) => new Date(2026, 9, 24, hours, minutes);

const rule = (id: string, condition: Condition, extra: Partial<Rule> = {}): Rule => ({
  id, enabled: true, condition, target: { type: 'scene', id: `scene-${id}` }, minSeconds: 20, multiMode: 'split', alternateSeconds: 10, ...extra,
});
const resolve = (rules: Rule[], sim: Sim, now: Date, active: Announcement[] = []) => resolvePlayback(display, rules, sim, now, active);
const weekdays: Condition = { kind: 'time', days: [1, 2, 3, 4, 5], from: '08:00', to: '10:00' };
const announcementRule = (templateIds: string[] = []): Condition => ({ kind: 'announcement', templateIds });
const closed: Announcement = { id: 'a1', templateId: 'tpl-closed', values: {}, displayIds: null, startsAt: monday(0).toISOString(), endsAt: null };
const printing = (machines: ('h2d' | 'x1c')[], mode: 'any' | 'all'): Condition => ({ kind: 'machines', machines, mode });

describe('time windows', () => {
  const window = weekdays as Extract<Condition, { kind: 'time' }>;
  it('match inside the window on a listed weekday', () => {
    expect(timeWindowActive(window, monday(9))).toBe(true);
    expect(timeWindowActive(window, monday(8))).toBe(true);
  });
  it('end exclusive and start inclusive', () => {
    expect(timeWindowActive(window, monday(10))).toBe(false);
    expect(timeWindowActive(window, monday(7, 59))).toBe(false);
  });
  it('do not match on days that are not listed', () => {
    expect(timeWindowActive(window, saturday(9))).toBe(false);
  });
  it('run over midnight into the day after a listed day', () => {
    const night: Extract<Condition, { kind: 'time' }> = { kind: 'time', days: [5], from: '22:00', to: '06:00' };
    expect(timeWindowActive(night, new Date(2026, 9, 23, 23))).toBe(true); // Friday evening
    expect(timeWindowActive(night, saturday(2))).toBe(true); // Saturday early morning
    expect(timeWindowActive(night, saturday(7))).toBe(false);
    expect(timeWindowActive(night, new Date(2026, 9, 23, 2))).toBe(false); // Friday early morning belongs to Thursday
  });
  it('wrap from Sunday to Monday', () => {
    const night: Extract<Condition, { kind: 'time' }> = { kind: 'time', days: [7], from: '23:00', to: '01:00' };
    expect(timeWindowActive(night, monday(0, 30))).toBe(true);
  });
});

describe('resolvePlayback', () => {
  it('falls back to the default playlist', () => {
    const result = resolve([rule('a', printing(['h2d', 'x1c'], 'any'))], idle, monday(12));
    expect(result.ruleId).toBe('default');
    expect(result.target).toEqual({ type: 'playlist', id: 'pl-ads' });
  });
  it('matches "any" machines', () => {
    const result = resolve([rule('a', printing(['h2d', 'x1c'], 'any'))], { ...idle, x1c: 'printing' }, monday(12));
    expect(result.ruleId).toBe('a');
    expect(result.activeMachines).toEqual(['x1c']);
    expect(result.reason).toBe('Rule 1: any of H2D, X1C printing');
  });
  it('needs every machine for "all"', () => {
    const rules = [rule('a', printing(['h2d', 'x1c'], 'all'))];
    expect(resolve(rules, { ...idle, h2d: 'printing' }, monday(12)).ruleId).toBe('default');
    expect(resolve(rules, { ...idle, h2d: 'printing', x1c: 'camera_unavailable' }, monday(12)).ruleId).toBe('a');
  });
  it('skips disabled rules', () => {
    const rules = [rule('a', printing(['h2d'], 'any'), { enabled: false }), rule('b', printing(['h2d'], 'any'))];
    expect(resolve(rules, { ...idle, h2d: 'printing' }, monday(12)).ruleId).toBe('b');
  });
  it('picks the first matching rule by priority', () => {
    const rules = [rule('time', weekdays), rule('print', printing(['h2d'], 'any'))];
    expect(resolve(rules, { ...idle, h2d: 'printing' }, monday(9)).ruleId).toBe('time');
    expect(resolve(rules, { ...idle, h2d: 'printing' }, monday(11)).ruleId).toBe('print');
    expect(resolve([...rules].reverse(), { ...idle, h2d: 'printing' }, monday(9)).ruleId).toBe('print');
  });
  it('never lets an active announcement jump the list without an announcement rule', () => {
    const rules = [rule('print', printing(['h2d'], 'any'))];
    expect(resolve(rules, { ...idle, h2d: 'printing' }, monday(12), [closed]).ruleId).toBe('print');
    expect(resolve([], idle, monday(12), [closed]).ruleId).toBe('default');
  });
  it('lets an announcement rule win only by its position in the list', () => {
    const rules = [rule('print', printing(['h2d'], 'any')), rule('notice', announcementRule()), rule('time', weekdays)];
    const sim = { ...idle, h2d: 'printing' as const };
    expect(resolve(rules, sim, monday(9), [closed]).ruleId).toBe('print');
    expect(resolve(rules, { ...sim, h2d: 'idle' }, monday(9), [closed]).ruleId).toBe('notice');
    expect(resolve(rules, { ...sim, h2d: 'idle' }, monday(9)).ruleId).toBe('time');
  });
  it('matches an announcement rule restricted to templates only for those templates', () => {
    const rules = [rule('closed', announcementRule(['tpl-closed'])), rule('any', announcementRule())];
    expect(resolve(rules, idle, monday(12), [closed]).ruleId).toBe('closed');
    expect(resolve(rules, idle, monday(12), [{ ...closed, templateId: 'tpl-other' }]).ruleId).toBe('any');
    expect(resolve([rules[0]], idle, monday(12), [{ ...closed, templateId: 'tpl-other' }]).ruleId).toBe('default');
  });
  it('matches the stale-data rule only while Core is unreachable', () => {
    const rules = [rule('stale', { kind: 'stale' })];
    expect(resolve(rules, idle, monday(12)).ruleId).toBe('default');
    expect(resolve(rules, { ...idle, coreReachable: false }, monday(12)).ruleId).toBe('stale');
  });
  it('reports the printing machines whichever rule wins', () => {
    const result = resolve([], { ...idle, h2d: 'printing', x1c: 'printing' }, monday(12));
    expect(result.activeMachines).toEqual(['h2d', 'x1c']);
  });
});

describe('descriptions', () => {
  it('summarises days compactly', () => {
    expect(describeDays([1, 2, 3, 4, 5])).toBe('Mon–Fri');
    expect(describeDays([1, 3])).toBe('Mon, Wed');
    expect(describeDays([1, 2, 3, 4, 5, 6, 7])).toBe('Every day');
  });
  it('describes conditions', () => {
    expect(describeCondition(weekdays)).toBe('Mon–Fri 08:00–10:00');
    expect(describeCondition(printing(['h2d', 'x1c'], 'all'))).toBe('All of H2D, X1C printing');
    expect(describeCondition({ kind: 'stale' })).toBe('Live data unavailable');
    expect(describeCondition(announcementRule())).toBe('Announcement active');
    expect(describeCondition(announcementRule(['tpl-closed']), () => 'Closed')).toBe('Announcement active (Closed)');
  });
});

describe('activeAnnouncementsFor', () => {
  const at = (id: string, patch: Partial<Announcement>): Announcement => ({ ...closed, id, startsAt: monday(8).toISOString(), endsAt: monday(12).toISOString(), ...patch });
  it('respects the start (inclusive) and end (exclusive) of the window', () => {
    const list = [at('a', {})];
    expect(activeAnnouncementsFor('d1', list, monday(7, 59))).toEqual([]);
    expect(activeAnnouncementsFor('d1', list, monday(8)).map((item) => item.id)).toEqual(['a']);
    expect(activeAnnouncementsFor('d1', list, monday(11, 59)).map((item) => item.id)).toEqual(['a']);
    expect(activeAnnouncementsFor('d1', list, monday(12))).toEqual([]);
  });
  it('keeps open-ended announcements until they are removed', () => {
    expect(activeAnnouncementsFor('d1', [at('a', { endsAt: null })], saturday(23)).map((item) => item.id)).toEqual(['a']);
  });
  it('targets all displays or only the selected ones', () => {
    const list = [at('all', { displayIds: null }), at('d2', { displayIds: ['d2'] }), at('d1', { displayIds: ['d1', 'd3'] })];
    expect(activeAnnouncementsFor('d1', list, monday(9)).map((item) => item.id)).toEqual(['all', 'd1']);
    expect(activeAnnouncementsFor('d2', list, monday(9)).map((item) => item.id)).toEqual(['all', 'd2']);
    expect(activeAnnouncementsFor('d4', list, monday(9)).map((item) => item.id)).toEqual(['all']);
  });
});

describe('renderAnnouncement', () => {
  const field = (key: string, type: AnnouncementTemplate['fields'][number]['type']) => ({ id: key, key, label: key, type, required: false, defaultValue: '', helper: '', options: [] });
  const template = (title: string, body = '', fields = [field('reason', 'text')]): AnnouncementTemplate => ({ id: 't', name: 'T', tone: 'warning', title, body, fields });
  const context = { now: monday(9), displayName: 'Entrance window', location: 'Ground floor' };
  const timing = (endsAt: Date | null) => ({ startsAt: monday(9), endsAt });

  it('fills fields and built-in variables and keeps the tone', () => {
    const result = renderAnnouncement(template('Closed – {reason}', '{display}, {location}, {today}, since {starts_at}'), { reason: 'Holiday' }, timing(monday(14, 30)), context);
    expect(result).toEqual({ title: 'Closed – Holiday', body: 'Entrance window, Ground floor, Mon 19 Oct, since 09:00', tone: 'warning' });
  });
  it('words {ends} by the end: today, another day, open-ended', () => {
    const render = (endsAt: Date | null) => renderAnnouncement(template('Back {ends}'), {}, timing(endsAt), context).title;
    expect(render(monday(14, 30))).toBe('Back at 14:30');
    expect(render(new Date(2026, 9, 21, 10))).toBe('Back on Wed 21 Oct at 10:00');
    expect(render(null)).toBe('Back until further notice');
  });
  it('renders {ends_at} and {ends_on} from the end, empty when open-ended', () => {
    expect(renderAnnouncement(template('{ends_at} / {ends_on}'), {}, timing(new Date(2026, 9, 21, 10)), context).title).toBe('10:00 / Wed 21 Oct');
    expect(renderAnnouncement(template('[{ends_at}][{ends_on}]'), {}, timing(null), context).title).toBe('[][]');
  });
  it('renders missing optional values empty and leaves unknown placeholders visible', () => {
    const result = renderAnnouncement(template('A {reason} B {nope}'), {}, timing(null), context);
    expect(result.title).toBe('A  B {nope}');
  });
  it('formats typed values: date, date and time, machine', () => {
    const fields = [field('on', 'date'), field('back', 'datetime'), field('machine', 'machine')];
    const values = { on: '2026-10-23', back: '2026-10-20T10:00', machine: 'h2d' };
    expect(renderAnnouncement(template('{on}|{back}|{machine}', '', fields), values, timing(null), context).title).toBe('Fri 23 Oct|tomorrow at 10:00|H2D');
    expect(renderAnnouncement(template('{back}', '', fields), { back: '2026-10-19T14:00' }, timing(null), context).title).toBe('today at 14:00');
    expect(renderAnnouncement(template('{back}', '', fields), { back: '2026-10-25T14:00' }, timing(null), context).title).toBe('on Sun 25 Oct at 14:00');
  });
  it('does not resolve inherited object keys', () => {
    expect(renderAnnouncement(template('{constructor}'), {}, timing(null), context).title).toBe('{constructor}');
  });
});

describe('template helpers', () => {
  it('flags placeholders that are neither fields nor built-ins', () => {
    const fields = [{ id: 'f', key: 'reason', label: 'Reason', type: 'text' as const, required: false, defaultValue: '', helper: '', options: [] }];
    expect(unknownPlaceholders({ fields, title: '{reason} {ends} {oops}', body: '{oops} {other}' })).toEqual(['oops', 'other']);
  });
  it('derives unique field keys that never collide with built-ins', () => {
    expect(fieldKeyFor('Back on', [])).toBe('back_on');
    expect(fieldKeyFor('Back on', ['back_on'])).toBe('back_on_2');
    expect(fieldKeyFor('Ends', [])).toBe('ends_2');
    expect(fieldKeyFor('  ', [])).toBe('field');
  });
});
