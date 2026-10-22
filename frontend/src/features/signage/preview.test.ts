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
    const data = buildPreviewData({
      preset: 'idle',
      now: now.getTime(),
      machines: [],
      templates: [],
      timeZone: 'Europe/Vienna',
      assets: [{ id: 'abc', sha256: 'f'.repeat(64) }],
    });
    expect(data.assetUrl('abc')).toContain(`?v=${'f'.repeat(64)}`);
    expect(data.assetUrl('other')).not.toContain('?v=');
  });

  it('previews the real open days and events and shows no invented ones', () => {
    const base = {
      preset: 'idle' as const,
      now: now.getTime(),
      machines: [],
      templates: [],
      timeZone: 'Europe/Vienna',
    };
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
    const machines = [
      { id: 'a', name: 'Plain', hasCamera: false },
      { id: 'b', name: 'Camera', hasCamera: true },
    ];
    const data = buildPreviewData({
      preset: 'all',
      now: now.getTime(),
      machines,
      templates: [],
      timeZone: 'Europe/Vienna',
    });
    expect([...(data.unavailableCameras ?? [])]).toEqual(['a']);
  });

  it('passes custom layouts, the calendar block and asset names on to the renderer', () => {
    const base = {
      preset: 'idle' as const,
      now: now.getTime(),
      machines: [],
      templates: [],
      timeZone: 'Europe/Vienna',
    };
    const plain = buildPreviewData(base);
    expect(plain.calendar).toBeNull();
    expect(plain.customLayouts).toEqual([]);
    const calendar = { from: '2026-10-01', to: '2026-12-01', holidays: [], breaks: [], openDays: [], events: [] };
    const customLayouts = [{ id: 'cl', mode: 'grid' as const, columns: [1], rows: [1], zones: [] }];
    const data = buildPreviewData({
      ...base,
      calendar,
      customLayouts,
      assets: [{ id: 'font-1', sha256: 'e'.repeat(64), name: 'Fira Sans' }],
    });
    expect(data.calendar).toEqual(calendar);
    expect(data.customLayouts).toEqual(customLayouts);
    expect(data.assetName?.('font-1')).toBe('Fira Sans');
    expect(data.assetName?.('other')).toBeNull();
  });

  it('renders announcement samples with their body format, escaping placeholder values for it', () => {
    const rich = {
      ...template,
      body: '**{reason}**',
      bodyFormat: 'markdown' as const,
      bodyCss: 'strong{color:red}',
      fields: [
        {
          key: 'reason',
          label: 'Reason',
          type: 'text' as const,
          required: false,
          defaultValue: 'a*b',
          helperText: '',
          options: [],
        },
      ],
    };
    const message = renderSample(rich, {}, now, 'Europe/Vienna');
    expect(message).toMatchObject({ body: '**a\\*b**', bodyFormat: 'markdown', bodyCss: 'strong{color:red}' });
  });
});
