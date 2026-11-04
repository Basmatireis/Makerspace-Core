import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../app/App';
import { queryClient } from '../../../api/query-client';
import { renderRoute } from '../../../test/render';
import { enterDemoMode, exitDemoMode } from '../../demo/demoMode';
import { demoPermissions, demoTestUser } from '../../demo/demoTestUser';
import { currentUserFixture } from '../../../test/fixtures';
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
const modalOnly = (selector: string) =>
  selector.includes('.cds--modal') || selector.includes('eligible-person') || selector.includes('-leave');
const find = (selector: string) => document.querySelector<HTMLElement>(selector);
const appear = (selector: string) =>
  waitFor(() => {
    const element = find(selector);
    expect(element, selector).not.toBeNull();
    return element!;
  });

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

  it('gates the sign-up and assign steps by permission', () => {
    const readOnly = demoTestUser(['open_days.read']);
    const tour = openDaysGuides[0];
    expect(tour.requires(readOnly)).toBe(true);
    const visible = tour.steps.filter((step) => step.requires?.(readOnly) ?? true).map((step) => step.id);
    expect(visible).not.toContain('join');
    expect(visible).not.toContain('assign');
    expect(visible).not.toContain('periods');
    expect(openDaysGuides[1].requires(readOnly)).toBe(false);
    expect(openDaysGuides[2].requires(readOnly)).toBe(false);
  });

  const routes = [
    ...new Set(openDaysGuides.flatMap((guide) => guide.steps.flatMap((step) => (step.route ? [step.route] : [])))),
  ];

  it.each(routes)('shows the page targets on %s', async (route) => {
    await enterDemoMode(everything);
    renderRoute(<App />, route);
    const targets = openDaysGuides.flatMap((guide) => {
      let current = '';
      return guide.steps.flatMap((step) => {
        current = step.route ?? current;
        return current === route && step.target && !modalOnly(step.target) ? [step.target] : [];
      });
    });
    expect(targets.length).toBeGreaterThan(0);
    for (const target of new Set(targets)) {
      await waitFor(() => expect(find(target), target).not.toBeNull(), { timeout: 3000 });
    }
  });

  const dayRoute = routes.find((route) => route.includes('/days/'))!;

  it('reaches the leave button and its confirmation after joining', async () => {
    await enterDemoMode(everything);
    renderRoute(<App />, dayRoute);
    fireEvent.click(await appear('[data-guide="open-days-join"]'));
    fireEvent.click(await appear('[data-guide="open-days-leave"]'));
    const confirm = openDaysGuides[1].steps.find((step) => step.id === 'confirm')!.target!;
    await waitFor(() => expect(find(confirm)).not.toBeNull());
    fireEvent.click(find(confirm)!);
    await waitFor(() => expect(find('[data-guide="open-days-join"]')).not.toBeNull());
    expect(screen.queryByText('Leave Open Day')).not.toBeInTheDocument();
  });

  it('reaches the search and the people list when assigning', async () => {
    await enterDemoMode(everything);
    renderRoute(<App />, dayRoute);
    fireEvent.click(await appear('[data-guide="open-days-assign"]'));
    const search = openDaysGuides[2].steps.find((step) => step.id === 'search')!.target!;
    await waitFor(() => expect(find(search)).not.toBeNull());
    const person = await appear('[data-guide="open-days-eligible-person"]');
    expect(person).not.toBeNull();
    fireEvent.click(person);
    await waitFor(() => expect(find('.cds--modal.is-visible')).toBeNull());
  });
});
