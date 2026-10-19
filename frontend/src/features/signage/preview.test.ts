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
});
