import { describe, expect, it } from 'vitest';
import { announcementTemplateUsage, templateInUse } from './helpers';
import { CLOSED_TEMPLATE_ID, displaysSeed, scenesSeed } from './mockData';
import type { Announcement } from './types';

const now = Date.parse('2026-10-19T12:00:00Z');
const announcement = (id: string, endsAt: string | null): Announcement => ({ id, templateId: CLOSED_TEMPLATE_ID, values: {}, displayIds: null, startsAt: '2026-10-19T08:00:00Z', endsAt });

describe('announcementTemplateUsage', () => {
  it('finds rules and announcement zones that filter on the template', () => {
    const usage = announcementTemplateUsage(CLOSED_TEMPLATE_ID, { announcements: [], displays: displaysSeed, scenes: scenesSeed }, now);
    expect(usage.rules.map((use) => [use.display.id, use.position])).toContainEqual(['display-entrance', 1]);
    expect(templateInUse(usage)).toBe(true);
  });

  it('counts open-ended and future announcements but not ended ones', () => {
    const usage = announcementTemplateUsage(CLOSED_TEMPLATE_ID, {
      announcements: [announcement('ended', '2026-10-19T10:00:00Z'), announcement('open', null), announcement('later', '2026-10-20T10:00:00Z')],
      displays: [], scenes: [],
    }, now);
    expect(usage.announcements.map((item) => item.id)).toEqual(['open', 'later']);
  });

  it('reports an unused template as free to delete', () => {
    const usage = announcementTemplateUsage('tpl-unused', { announcements: [announcement('open', null)], displays: displaysSeed, scenes: scenesSeed }, now);
    expect(templateInUse(usage)).toBe(false);
  });
});
