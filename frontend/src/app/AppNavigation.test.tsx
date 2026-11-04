import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Link } from 'react-router-dom';
import { PermissionId } from '../api/generated/models';
import { defaultPublicConfiguration } from '../features/branding/branding';
import { currentUserFixture } from '../test/fixtures';
import { renderRoute } from '../test/render';
import { AppNavigation } from './AppNavigation';

describe('AppNavigation', () => {
  it('hides empty groups and gives a staffing-only user the accessible destination', async () => {
    const user = userEvent.setup();
    renderRoute(
      <AppNavigation
        currentUser={currentUserFixture([PermissionId.supervisor_dashboardread])}
        legal={defaultPublicConfiguration.legal}
        onNavigate={vi.fn()}
      />,
      '/dashboard',
    );

    expect(screen.queryByRole('button', { name: 'Operations' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Workshop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sales & payments' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Directory' }));
    expect(screen.getByRole('link', { name: 'Staffing' })).toHaveAttribute('href', '/people/staffing');
    expect(screen.queryByRole('link', { name: 'People' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Organizations' })).not.toBeInTheDocument();
  });

  it('lists the Workshop destinations in order and gates each by its permission', () => {
    renderRoute(
      <AppNavigation
        currentUser={currentUserFixture([PermissionId.machinesread, PermissionId.inventoryread])}
        legal={defaultPublicConfiguration.legal}
        onNavigate={vi.fn()}
      />,
      '/workshop/inventory/spools/spool-1',
    );

    expect(screen.getByRole('button', { name: 'Workshop' })).toHaveAttribute('aria-expanded', 'true');
    const links = screen.getAllByRole('link').filter((link) => link.getAttribute('href')?.startsWith('/workshop'));
    expect(links.map((link) => link.textContent)).toEqual(['Machines', 'Inventory']);
    expect(screen.getByRole('link', { name: 'Inventory' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link', { name: 'Overview' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Jobs' })).not.toBeInTheDocument();
  });

  it('offers Jobs, Machines and Inventory under Workshop and Statistics under Administration', () => {
    renderRoute(
      <AppNavigation
        currentUser={currentUserFixture([
          PermissionId.machine_jobsread,
          PermissionId.machinesread,
          PermissionId.inventoryread,
          PermissionId.statisticsread,
        ])}
        legal={defaultPublicConfiguration.legal}
        onNavigate={vi.fn()}
      />,
      '/workshop/jobs/runs/run-1',
    );

    const links = screen.getAllByRole('link').filter((link) => link.getAttribute('href')?.startsWith('/workshop'));
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Jobs', '/workshop/jobs'],
      ['Machines', '/workshop/machines'],
      ['Inventory', '/workshop/inventory'],
    ]);
    expect(screen.getByRole('link', { name: 'Jobs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Administration')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Statistics' })).toHaveAttribute('href', '/statistics');
  });

  it('shows Statistics above Settings and marks it active, gated by statistics.read', () => {
    renderRoute(
      <AppNavigation
        currentUser={currentUserFixture([PermissionId.statisticsread])}
        legal={defaultPublicConfiguration.legal}
        onNavigate={vi.fn()}
      />,
      '/statistics',
    );

    expect(screen.getByText('Administration')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Statistics' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: 'Workshop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('hides Statistics and the Administration heading without statistics.read', () => {
    renderRoute(
      <AppNavigation
        currentUser={currentUserFixture([PermissionId.machine_jobsread])}
        legal={defaultPublicConfiguration.legal}
        onNavigate={vi.fn()}
      />,
      '/dashboard',
    );

    expect(screen.queryByRole('link', { name: 'Statistics' })).not.toBeInTheDocument();
    expect(screen.queryByText('Administration')).not.toBeInTheDocument();
  });

  it('opens the active group after client navigation and marks the active destination', async () => {
    const user = userEvent.setup();
    renderRoute(
      <>
        <Link to="/events">Navigate to events</Link>
        <AppNavigation
          currentUser={currentUserFixture([PermissionId.eventsread])}
          legal={defaultPublicConfiguration.legal}
          onNavigate={vi.fn()}
        />
      </>,
      '/dashboard',
    );

    expect(screen.getByRole('button', { name: 'Operations' })).toHaveAttribute('aria-expanded', 'false');
    await user.click(screen.getByRole('link', { name: 'Navigate to events' }));
    expect(screen.getByRole('button', { name: 'Operations' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Events' })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps keyboard focus while Carbon expands, collapses, and reopens a group', async () => {
    const user = userEvent.setup();
    renderRoute(
      <>
        <Link to="/events">Open events route</Link>
        <AppNavigation
          currentUser={currentUserFixture([PermissionId.eventsread])}
          legal={defaultPublicConfiguration.legal}
          onNavigate={vi.fn()}
        />
      </>,
      '/dashboard',
    );

    const operations = screen.getByRole('button', { name: 'Operations' });
    operations.focus();
    await user.keyboard('{Enter}');
    expect(operations).toHaveFocus();
    expect(operations).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{Escape}');
    expect(operations).toHaveFocus();
    expect(operations).toHaveAttribute('aria-expanded', 'false');

    await user.keyboard('{Enter}');
    expect(operations).toHaveFocus();
    expect(operations).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{Escape}');
    expect(operations).toHaveAttribute('aria-expanded', 'false');
    await user.click(screen.getByRole('link', { name: 'Open events route' }));
    expect(operations).toHaveAttribute('aria-expanded', 'true');
  });

  it('reports internal selections and preserves external legal links', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    renderRoute(
      <AppNavigation
        currentUser={currentUserFixture()}
        legal={{
          imprint: { mode: 'external', href: 'https://example.test/imprint' },
          privacy: { mode: 'internal', href: '/legal/privacy' },
        }}
        onNavigate={onNavigate}
      />,
      '/dashboard',
    );

    await user.click(screen.getByRole('link', { name: 'About' }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Imprint' })).toHaveAttribute('href', 'https://example.test/imprint');
    expect(screen.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', '/legal/privacy');
  });

  it('exposes stable guide hooks on the groups and on every item', async () => {
    const user = userEvent.setup();
    renderRoute(
      <AppNavigation
        currentUser={currentUserFixture([PermissionId.machinesread, PermissionId.ordersread, PermissionId.pricingread])}
        legal={defaultPublicConfiguration.legal}
        onNavigate={vi.fn()}
      />,
      '/dashboard',
    );
    expect(document.querySelector('ul.app-side-nav__primary')).not.toBeNull();
    expect(document.querySelector('a[data-guide="nav-dashboard"]')).toHaveAttribute('href', '/dashboard');
    expect(document.querySelector('li[data-guide="nav-group-workshop"] > button')).not.toBeNull();
    expect(document.querySelector('li[data-guide="nav-group-sales"] > button')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Workshop' }));
    expect(document.querySelector('a[data-guide="nav-workshop-machines"]')).toHaveAttribute(
      'href',
      '/workshop/machines',
    );
    await user.click(screen.getByRole('button', { name: 'Sales & payments' }));
    expect(document.querySelector('a[data-guide="nav-pricing"]')).toHaveAttribute('href', '/pricing');
    expect(document.querySelector('a[data-guide="nav-orders"]')).toHaveAttribute('href', '/orders');
  });
});
