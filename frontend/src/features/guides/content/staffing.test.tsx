import { describe, expect, it } from 'vitest';
import { demoTestUser } from '../../demo/demoTestUser';
import { currentUserFixture } from '../../../test/fixtures';
import { guides } from './index';
import { staffingGuides } from './staffing';

describe('staffing guides', () => {
  const [tour] = staffingGuides;

  it('is registered once and only offered to people who see the staffing page', () => {
    expect(guides.filter((guide) => guide.id === 'staffing-tour')).toHaveLength(1);
    expect(new Set(guides.map((guide) => guide.id)).size).toBe(guides.length);
    expect(tour.requires(currentUserFixture([]))).toBe(false);
    expect(tour.requires(demoTestUser(['supervisor_dashboard.read']))).toBe(true);
    expect(tour.suggestOn?.test('/people/staffing')).toBe(true);
    expect(tour.suggestOn?.test('/people')).toBe(false);
  });

  it('starts on the dashboard and has unique steps', () => {
    expect(new Set(tour.steps.map((step) => step.id)).size).toBe(tour.steps.length);
    expect(tour.steps[0].route).toBe('/dashboard');
    expect(tour.steps.slice(1).filter((step) => step.route)).toEqual([]);
  });

  it('mentions saving the rules only to people who may change them', () => {
    const viewer = demoTestUser(['supervisor_dashboard.read']);
    const manager = demoTestUser(['supervisor_dashboard.read', 'open_days.manage']);
    const ids = (user: typeof viewer) => tour.steps.filter((step) => step.requires?.(user) ?? true).map((s) => s.id);
    expect(ids(viewer)).not.toContain('edit-rules');
    expect(ids(manager)).toContain('edit-rules');
  });
});
