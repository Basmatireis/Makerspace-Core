import { describe, expect, it } from 'vitest';
import { describeCondition, describeDays, resolvePlayback, timeWindowActive } from './engine';
import type { Condition, Rule, Sim } from './types';

const idle: Sim = { h2d: 'idle', x1c: 'idle', coreReachable: true, announcement: false };
const display = { defaultPlaylistId: 'pl-ads', announcement: null };
// 2026-10-19 is a Monday.
const monday = (hours: number, minutes = 0) => new Date(2026, 9, 19, hours, minutes);
const saturday = (hours: number, minutes = 0) => new Date(2026, 9, 24, hours, minutes);

const rule = (id: string, condition: Condition, extra: Partial<Rule> = {}): Rule => ({
  id, enabled: true, condition, target: { type: 'scene', id: `scene-${id}` }, minSeconds: 20, multiMode: 'split', alternateSeconds: 10, ...extra,
});
const weekdays: Condition = { kind: 'time', days: [1, 2, 3, 4, 5], from: '08:00', to: '10:00' };
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
    const result = resolvePlayback(display, [rule('a', printing(['h2d', 'x1c'], 'any'))], idle, monday(12));
    expect(result.ruleId).toBe('default');
    expect(result.target).toEqual({ type: 'playlist', id: 'pl-ads' });
  });
  it('matches "any" machines', () => {
    const result = resolvePlayback(display, [rule('a', printing(['h2d', 'x1c'], 'any'))], { ...idle, x1c: 'printing' }, monday(12));
    expect(result.ruleId).toBe('a');
    expect(result.activeMachines).toEqual(['x1c']);
    expect(result.reason).toBe('Rule 1: any of H2D, X1C printing');
  });
  it('needs every machine for "all"', () => {
    const rules = [rule('a', printing(['h2d', 'x1c'], 'all'))];
    expect(resolvePlayback(display, rules, { ...idle, h2d: 'printing' }, monday(12)).ruleId).toBe('default');
    expect(resolvePlayback(display, rules, { ...idle, h2d: 'printing', x1c: 'camera_unavailable' }, monday(12)).ruleId).toBe('a');
  });
  it('skips disabled rules', () => {
    const rules = [rule('a', printing(['h2d'], 'any'), { enabled: false }), rule('b', printing(['h2d'], 'any'))];
    expect(resolvePlayback(display, rules, { ...idle, h2d: 'printing' }, monday(12)).ruleId).toBe('b');
  });
  it('picks the first matching rule by priority', () => {
    const rules = [rule('time', weekdays), rule('print', printing(['h2d'], 'any'))];
    expect(resolvePlayback(display, rules, { ...idle, h2d: 'printing' }, monday(9)).ruleId).toBe('time');
    expect(resolvePlayback(display, rules, { ...idle, h2d: 'printing' }, monday(11)).ruleId).toBe('print');
    expect(resolvePlayback(display, [...rules].reverse(), { ...idle, h2d: 'printing' }, monday(9)).ruleId).toBe('print');
  });
  it('lets an announcement win over everything when no announcement rule exists', () => {
    const rules = [rule('print', printing(['h2d'], 'any'))];
    const result = resolvePlayback(display, rules, { ...idle, h2d: 'printing', announcement: true }, monday(12));
    expect(result.ruleId).toBe('announcement');
    expect(result.target).toEqual({ type: 'scene', id: 'scene-closed' });
  });
  it('lets an announcement beat only the rules below its own rule', () => {
    const rules = [rule('print', printing(['h2d'], 'any')), rule('notice', { kind: 'announcement' }), rule('time', weekdays)];
    const sim = { ...idle, h2d: 'printing' as const, announcement: true };
    expect(resolvePlayback(display, rules, sim, monday(9)).ruleId).toBe('print');
    expect(resolvePlayback(display, rules, { ...sim, h2d: 'idle' }, monday(9)).ruleId).toBe('notice');
  });
  it('uses the display takeover and ignores an expired one', () => {
    const takeover = { sceneId: null, text: 'Back at 14:00', until: new Date(2026, 9, 19, 13).toISOString() };
    const live = resolvePlayback({ ...display, announcement: takeover }, [], idle, monday(12));
    expect(live.ruleId).toBe('announcement');
    expect(live.announcement?.text).toBe('Back at 14:00');
    expect(resolvePlayback({ ...display, announcement: takeover }, [], idle, monday(14)).ruleId).toBe('default');
  });
  it('matches the stale-data rule only while Core is unreachable', () => {
    const rules = [rule('stale', { kind: 'stale' })];
    expect(resolvePlayback(display, rules, idle, monday(12)).ruleId).toBe('default');
    expect(resolvePlayback(display, rules, { ...idle, coreReachable: false }, monday(12)).ruleId).toBe('stale');
  });
  it('reports the printing machines whichever rule wins', () => {
    const result = resolvePlayback(display, [], { ...idle, h2d: 'printing', x1c: 'printing' }, monday(12));
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
  });
});
