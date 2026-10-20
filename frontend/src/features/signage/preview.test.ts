import { describe, expect, it } from 'vitest';
import { assetContentUrl, buildPreviewData, renderSample } from './preview';
import { templateFixture } from './testFixtures';

const template = { ...templateFixture(), title: 'Until {ends_at}', body: '', fields: [] };
const now = new Date('2026-10-20T22:30:00Z');

describe('signage preview helpers', () => {
  it('renders announcement times in the given makerspace time zone, not the browser zone', () => {
    expect(renderSample(template, {}, now, 'Europe/Vienna').title).toBe('Until 02:30');
    expect(renderSample(template, {}, now, 'America/New_York').title).toBe('Until 20:30');
  });

  it('adds the content digest to asset URLs when it is known', () => {
    expect(assetContentUrl('abc', 'f'.repeat(64))).toBe(`/api/v1/signage/assets/abc/content?v=${'f'.repeat(64)}`);
    expect(assetContentUrl('abc')).toBe('/api/v1/signage/assets/abc/content');
    const data = buildPreviewData({ preset: 'idle', now: now.getTime(), machines: [], templates: [], timeZone: 'Europe/Vienna', assets: [{ id: 'abc', sha256: 'f'.repeat(64) }] });
    expect(data.assetUrl('abc')).toContain(`?v=${'f'.repeat(64)}`);
    expect(data.assetUrl('other')).not.toContain('?v=');
  });

  it('previews the real open days and events and shows no invented ones', () => {
    const base = { preset: 'idle' as const, now: now.getTime(), machines: [], templates: [], timeZone: 'Europe/Vienna' };
    const empty = buildPreviewData(base);
    expect(empty.openDays).toEqual([]);
    expect(empty.events).toEqual([]);
    const openDays = [{ startsAt: '2026-10-24T14:00:00Z', endsAt: '2026-10-24T17:00:00Z', status: 'scheduled' }];
    const events = [{ title: 'Repair cafe', startsAt: '2026-10-25T16:00:00Z', location: 'Workshop floor' }];
    const real = buildPreviewData({ ...base, openDays, events });
    expect(real.openDays).toEqual(openDays);
    expect(real.events).toEqual(events);
  });

  it('never lets a machine without a camera show one', () => {
    const machines = [{ id: 'a', name: 'Plain', hasCamera: false }, { id: 'b', name: 'Camera', hasCamera: true }];
    const data = buildPreviewData({ preset: 'all', now: now.getTime(), machines, templates: [], timeZone: 'Europe/Vienna' });
    expect([...(data.unavailableCameras ?? [])]).toEqual(['a']);
  });
});
