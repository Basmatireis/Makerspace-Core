import { fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../app/App';
import { queryClient } from '../../../api/query-client';
import { renderRoute } from '../../../test/render';
import { enterDemoMode, exitDemoMode } from '../../demo/demoMode';
import { demoPermissions, demoTestUser } from '../../demo/demoTestUser';
import { currentUserFixture } from '../../../test/fixtures';
import type { CurrentUser } from '../../../api/generated/models';
import type { GuideDefinition } from '../types';
import { openDaysGuides } from './openDays';

vi.mock('@carbon/charts-react', () => ({
  LineChart: () => <div data-testid="line-chart" />,
  SimpleBarChart: () => <div data-testid="bar-chart" />,
}));

afterEach(async () => {
  await exitDemoMode();
  queryClient.clear();
});

const everything = demoTestUser([...demoPermissions, 'open_days.manage']);
// Targets that only exist after a click inside the workflow.
const afterClick = (selector: string) =>
  ['eligible-person', '-leave', 'assign-search'].some((part) => selector.includes(part));
const find = (selector: string) => document.querySelector<HTMLElement>(selector);
const appear = (selector: string) =>
  waitFor(() => {
    const element = find(selector);
    expect(element, selector).not.toBeNull();
    return element!;
  });
const visibleSteps = (guide: GuideDefinition, user: CurrentUser) =>
  guide.steps.filter((step) => step.requires?.(user) ?? true).map((step) => step.id);

describe('open days guides', () => {
  it('has unique ids and hides every guide from people without open day permissions', () => {
    const ids = openDaysGuides.map((guide) => guide.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['open-days-tour', 'open-days-sign-up', 'open-days-assign']);
    const nobody = currentUserFixture([]);
    for (const guide of openDaysGuides) {
      expect(guide.demo).toBe(true);
      expect(guide.requires(nobody)).toBe(false);
      expect(guide.requires(everything)).toBe(true);
      expect(new Set(guide.steps.map((step) => step.id)).size).toBe(guide.steps.length);
    }
  });

  it('shows each audience its own steps', () => {
    const tour = openDaysGuides[0];
    const readOnly = demoTestUser(['open_days.read']);
    expect(tour.requires(readOnly)).toBe(true);
    const reader = visibleSteps(tour, readOnly);
    expect(reader).toContain('nav-open-days');
    expect(reader).toContain('schedule-tabs-read');
    for (const hidden of ['periods', 'period-open', 'join', 'assign', 'add-days', 'save', 'schedule-tabs-member']) {
      expect(reader).not.toContain(hidden);
    }
    expect(openDaysGuides[1].requires(readOnly)).toBe(false);
    expect(openDaysGuides[2].requires(readOnly)).toBe(false);

    const member = visibleSteps(tour, demoTestUser(['open_days.read', 'open_days.signup']));
    expect(member).toEqual(expect.arrayContaining(['schedule-tabs-member', 'join', 'calendar-subscription']));
    for (const hidden of ['periods', 'add-days', 'save', 'schedule-tabs-manage']) expect(member).not.toContain(hidden);

    const leitung = visibleSteps(tour, demoTestUser(['open_days.read', 'open_days.manage']));
    expect(leitung).toEqual(
      expect.arrayContaining(['periods', 'period-tabs', 'period-open', 'schedule-tabs-manage', 'add-days', 'save']),
    );
    for (const hidden of ['schedule-tabs-member', 'schedule-tabs-read', 'join']) expect(leitung).not.toContain(hidden);
  });

  it('only the first step of the tour jumps to a route', () => {
    const [first, ...rest] = openDaysGuides[0].steps;
    expect(first.route).toBe('/dashboard');
    expect(rest.filter((step) => step.route)).toEqual([]);
  });

  const tourStep = (id: string) => openDaysGuides[0].steps.find((step) => step.id === id)!.target!;

  it('tour: follows the pages from the dashboard to a day', async () => {
    await enterDemoMode(everything);
    renderRoute(<App />, '/dashboard');
    for (const id of ['next-up', 'semester', 'coming-up']) await appear(tourStep(id));
    fireEvent.click(await appear(tourStep('nav-open-days')));
    for (const id of ['periods', 'period-tabs']) await appear(tourStep(id));
    fireEvent.click(await appear('[data-guide="open-days-periods"] tbody tr'));
    fireEvent.click(await appear(tourStep('period-open')));
    for (const id of ['schedule-tabs-manage', 'glance', 'view', 'schedule', 'add-days']) await appear(tourStep(id));
    fireEvent.click(await appear(tourStep('day-click')));
    await appear(tourStep('positions'));
    await appear(tourStep('join'));
    await appear(tourStep('assign'));
  });

  it('tour: members land on the schedule of the current period', async () => {
    await enterDemoMode(demoTestUser());
    renderRoute(<App />, '/dashboard');
    fireEvent.click(await appear(tourStep('nav-open-days')));
    for (const id of ['schedule-tabs-member', 'glance', 'schedule']) await appear(tourStep(id));
    await appear(tourStep('calendar-subscription'));
  });

  const routes = [
    ...new Set(openDaysGuides.flatMap((guide) => guide.steps.flatMap((step) => (step.route ? [step.route] : [])))),
  ];

  it.each(routes)('shows the page targets of the workflows on %s', async (route) => {
    await enterDemoMode(everything);
    renderRoute(<App />, route);
    const targets = openDaysGuides.slice(1).flatMap((guide) => {
      let current = '';
      return guide.steps.flatMap((step) => {
        current = step.route ?? current;
        return current === route && step.target && !afterClick(step.target) ? [step.target] : [];
      });
    });
    for (const target of new Set(targets)) {
      await waitFor(() => expect(find(target), target).not.toBeNull(), { timeout: 3000 });
    }
  });

  const dayRoute = openDaysGuides[1].steps[0].route!;

  it('reaches the leave button after joining and frees the place again', async () => {
    await enterDemoMode(everything);
    renderRoute(<App />, dayRoute);
    fireEvent.click(await appear('[data-guide="open-days-join"]'));
    fireEvent.click(await appear('[data-guide="open-days-leave"]'));
    await waitFor(() => expect(find('[data-guide="open-days-join"]')).not.toBeNull());
    expect(find('[data-guide="open-days-leave"]')).toBeNull();
  });

  it('reaches the search and the people list when assigning', async () => {
    await enterDemoMode(everything);
    renderRoute(<App />, dayRoute);
    fireEvent.click(await appear('[data-guide="open-days-assign"]'));
    await appear(openDaysGuides[2].steps.find((step) => step.id === 'search')!.target!);
    const person = await appear(
      '[data-guide="open-days-eligible-person"] [role="button"], [data-guide="open-days-eligible-person"] button',
    );
    fireEvent.click(person);
    await waitFor(() => expect(find('[data-guide="open-days-eligible-person"]')).toBeNull());
  });
});
