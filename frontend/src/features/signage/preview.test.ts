import { describe, expect, it } from 'vitest';
import { assetContentUrl, buildPreviewData, renderSample } from './preview';
import { resolvePublished } from './publishedView';
import { previewFixture, templateFixture } from './testFixtures';

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

  it('passes the calendar block and asset names on to the renderer', () => {
    const base = {
      preset: 'idle' as const,
      now: now.getTime(),
      machines: [],
      templates: [],
      timeZone: 'Europe/Vienna',
    };
    const plain = buildPreviewData(base);
    expect(plain.calendar).toBeNull();
    const calendar = { from: '2026-10-01', to: '2026-12-01', holidays: [], breaks: [], openDays: [], events: [] };
    const data = buildPreviewData({
      ...base,
      calendar,
      assets: [{ id: 'font-1', sha256: 'e'.repeat(64), name: 'Fira Sans' }],
    });
    expect(data.calendar).toEqual(calendar);
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

describe('published view timelapses', () => {
  it('plays the live clips from the staff content URL addressed by digest', () => {
    const sha = 'ab'.repeat(32);
    const clip = {
      runId: 'run-1',
      machineId: 'm1',
      machineName: 'MK4',
      endedAt: '2026-10-21T10:00:00Z',
      sha256: sha,
      sizeBytes: 10,
      url: `/api/v1/signage/player/timelapses/run-1/${sha}`,
    };
    const base = previewFixture();
    const view = resolvePublished(
      { ...base, live: { ...base.live, timelapses: [clip] } },
      { now: Date.parse('2026-10-22T10:00:00Z'), timeZone: 'Europe/Vienna' },
    );
    expect(view?.data.timelapses).toEqual([clip]);
    expect(view?.data.timelapseUrl?.(clip)).toBe(`/api/v1/signage/timelapses/run-1/content?v=${sha}`);
    const editor = buildPreviewData({ preset: 'idle', now: 0, machines: [], templates: [], timeZone: 'UTC' });
    expect(editor.timelapses).toBeUndefined();
  });
});
