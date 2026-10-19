import { describe, expect, it } from 'vitest';
import { describeCondition, describeDays, loopSeconds, playlistPosition, resolvePlayback, timeWindowActive, type PlaybackContext, type PlaybackRule } from './playback';

const H2D = 'machine-h2d';
const X1C = 'machine-x1c';
// 2026-10-19 is a Monday.
const monday = (hours: number, minutes = 0) => new Date(2026, 9, 19, hours, minutes);
const saturday = (hours: number, minutes = 0) => new Date(2026, 9, 24, hours, minutes);

const base: Omit<PlaybackRule, 'id'> = {
  kind: 'live_data_unavailable', weekdays: [], timeFrom: null, timeTo: null, machineIds: [], machineMatch: null, announcementTemplateIds: [],
  targetKind: 'scene', targetId: 'scene-x', minSeconds: 20, multiMode: 'split', alternateSeconds: 10, enabled: true,
};
const rule = (id: string, patch: Partial<PlaybackRule>): PlaybackRule => ({ ...base, id, targetId: `scene-${id}`, ...patch });
const weekdays = rule('time', { kind: 'time_window', weekdays: [1, 2, 3, 4, 5], timeFrom: '08:00', timeTo: '10:00' });
const printing = (id: string, machineIds: string[], machineMatch: 'any' | 'all', patch: Partial<PlaybackRule> = {}) => rule(id, { kind: 'machine_printing', machineIds, machineMatch, ...patch });
const announcement = (id: string, announcementTemplateIds: string[] = []) => rule(id, { kind: 'announcement_active', announcementTemplateIds });

const idle = (now: Date, patch: Partial<PlaybackContext> = {}): PlaybackContext => ({ now, printingMachineIds: [], activeAnnouncementTemplateIds: [], liveDataAvailable: true, ...patch });
const resolve = (rules: PlaybackRule[], context: PlaybackContext) => resolvePlayback('pl-ads', rules, context);

describe('time windows', () => {
  it('match inside the window on a listed weekday, start inclusive and end exclusive', () => {
    expect(timeWindowActive(weekdays, monday(9))).toBe(true);
    expect(timeWindowActive(weekdays, monday(8))).toBe(true);
    expect(timeWindowActive(weekdays, monday(10))).toBe(false);
    expect(timeWindowActive(weekdays, monday(7, 59))).toBe(false);
  });
  it('do not match on days that are not listed', () => {
    expect(timeWindowActive(weekdays, saturday(9))).toBe(false);
  });
  it('never match an empty window', () => {
    expect(timeWindowActive({ weekdays: [1], timeFrom: '08:00', timeTo: '08:00' }, monday(8))).toBe(false);
  });
  it('run over midnight into the day after a listed day', () => {
    const night = { weekdays: [5], timeFrom: '22:00', timeTo: '06:00' };
    expect(timeWindowActive(night, new Date(2026, 9, 23, 23))).toBe(true); // Friday evening
    expect(timeWindowActive(night, saturday(2))).toBe(true); // Saturday early morning
    expect(timeWindowActive(night, saturday(7))).toBe(false);
    expect(timeWindowActive(night, new Date(2026, 9, 23, 2))).toBe(false); // Friday early morning belongs to Thursday
  });
  it('wrap from Sunday to Monday', () => {
    expect(timeWindowActive({ weekdays: [7], timeFrom: '23:00', timeTo: '01:00' }, monday(0, 30))).toBe(true);
  });
});

describe('resolvePlayback', () => {
  it('falls back to the default playlist', () => {
    const result = resolve([printing('a', [H2D, X1C], 'any')], idle(monday(12)));
    expect(result.ruleId).toBe('default');
    expect(result.rulePosition).toBeNull();
    expect(result.target).toEqual({ kind: 'playlist', id: 'pl-ads' });
  });
  it('matches "any" machines and names the reason', () => {
    const result = resolvePlayback('pl-ads', [printing('a', [H2D, X1C], 'any')], idle(monday(12), { printingMachineIds: [X1C] }), { machine: (id) => id.replace('machine-', '').toUpperCase(), template: (id) => id });
    expect(result.ruleId).toBe('a');
    expect(result.activeMachineIds).toEqual([X1C]);
    expect(result.reason).toBe('Rule 1: any of H2D, X1C printing');
  });
  it('needs every machine for "all"', () => {
    const rules = [printing('a', [H2D, X1C], 'all')];
    expect(resolve(rules, idle(monday(12), { printingMachineIds: [H2D] })).ruleId).toBe('default');
    expect(resolve(rules, idle(monday(12), { printingMachineIds: [H2D, X1C] })).ruleId).toBe('a');
  });
  it('never matches a machine rule without machines', () => {
    expect(resolve([printing('a', [], 'any')], idle(monday(12), { printingMachineIds: [H2D] })).ruleId).toBe('default');
  });
  it('skips disabled rules', () => {
    const rules = [printing('a', [H2D], 'any', { enabled: false }), printing('b', [H2D], 'any')];
    expect(resolve(rules, idle(monday(12), { printingMachineIds: [H2D] })).ruleId).toBe('b');
  });
  it('treats published rules without an enabled flag as enabled', () => {
    const published: PlaybackRule = { ...printing('a', [H2D], 'any'), enabled: undefined };
    expect(resolve([published], idle(monday(12), { printingMachineIds: [H2D] })).ruleId).toBe('a');
  });
  it('picks the first matching rule by priority', () => {
    const rules = [weekdays, printing('print', [H2D], 'any')];
    const context = (now: Date) => idle(now, { printingMachineIds: [H2D] });
    expect(resolve(rules, context(monday(9))).ruleId).toBe('time');
    expect(resolve(rules, context(monday(11))).ruleId).toBe('print');
    expect(resolve([...rules].reverse(), context(monday(9))).ruleId).toBe('print');
  });
  it('never lets an active announcement jump the list without an announcement rule', () => {
    const active = idle(monday(12), { printingMachineIds: [H2D], activeAnnouncementTemplateIds: ['tpl-closed'] });
    expect(resolve([printing('print', [H2D], 'any')], active).ruleId).toBe('print');
    expect(resolve([], active).ruleId).toBe('default');
  });
  it('lets an announcement rule win only by its position in the list', () => {
    const rules = [printing('print', [H2D], 'any'), announcement('notice'), weekdays];
    const closed = ['tpl-closed'];
    expect(resolve(rules, idle(monday(9), { printingMachineIds: [H2D], activeAnnouncementTemplateIds: closed })).ruleId).toBe('print');
    expect(resolve(rules, idle(monday(9), { activeAnnouncementTemplateIds: closed })).ruleId).toBe('notice');
    expect(resolve(rules, idle(monday(9))).ruleId).toBe('time');
  });
  it('matches an announcement rule restricted to templates only for those templates', () => {
    const rules = [announcement('closed', ['tpl-closed']), announcement('any')];
    expect(resolve(rules, idle(monday(12), { activeAnnouncementTemplateIds: ['tpl-closed'] })).ruleId).toBe('closed');
    expect(resolve(rules, idle(monday(12), { activeAnnouncementTemplateIds: ['tpl-other'] })).ruleId).toBe('any');
    expect(resolve([rules[0]], idle(monday(12), { activeAnnouncementTemplateIds: ['tpl-other'] })).ruleId).toBe('default');
  });
  it('matches the live-data rule only while live data is unavailable', () => {
    const rules = [rule('stale', {})];
    expect(resolve(rules, idle(monday(12))).ruleId).toBe('default');
    expect(resolve(rules, idle(monday(12), { liveDataAvailable: false })).ruleId).toBe('stale');
  });
  it('reports the printing machines and the rule settings of the winner', () => {
    const result = resolve([rule('a', { kind: 'live_data_unavailable', multiMode: 'alternate', alternateSeconds: 15, minSeconds: 30 })], idle(monday(12), { printingMachineIds: [H2D, X1C], liveDataAvailable: false }));
    expect(result).toMatchObject({ activeMachineIds: [H2D, X1C], multiMode: 'alternate', alternateSeconds: 15, minSeconds: 30, rulePosition: 1 });
  });
});

describe('descriptions', () => {
  it('summarises days compactly', () => {
    expect(describeDays([1, 2, 3, 4, 5])).toBe('Mon–Fri');
    expect(describeDays([1, 3])).toBe('Mon, Wed');
    expect(describeDays([1, 2, 3, 4, 5, 6, 7])).toBe('Every day');
    expect(describeDays([])).toBe('No day');
  });
  it('describes conditions', () => {
    const names = { machine: (id: string) => id.toUpperCase(), template: () => 'Closed' };
    expect(describeCondition(weekdays)).toBe('Mon–Fri 08:00–10:00');
    expect(describeCondition(printing('p', ['h2d', 'x1c'], 'all'), names)).toBe('All of H2D, X1C printing');
    expect(describeCondition(rule('s', {}))).toBe('Live data unavailable');
    expect(describeCondition(announcement('a'))).toBe('Announcement active');
    expect(describeCondition(announcement('a', ['t']), names)).toBe('Announcement active (Closed)');
  });
});

describe('playlists', () => {
  const items = [{ seconds: 10 }, { seconds: 20 }, { seconds: 5 }];
  it('sums the loop', () => expect(loopSeconds(items)).toBe(35));
  it('finds the item on screen and the seconds left', () => {
    expect(playlistPosition(items, 0)).toMatchObject({ index: 0, secondsLeft: 10 });
    expect(playlistPosition(items, 12.5)).toMatchObject({ index: 1, secondsLeft: 18 });
    expect(playlistPosition(items, 34)).toMatchObject({ index: 2, secondsLeft: 1 });
    expect(playlistPosition(items, 35)).toMatchObject({ index: 0 });
    expect(playlistPosition([], 3)).toBeNull();
  });
});
