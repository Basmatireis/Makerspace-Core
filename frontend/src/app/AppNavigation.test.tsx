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
    expect(screen.queryByRole('button', { name: 'Machines & inventory' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sales & payments' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'People' }));
    expect(screen.getByRole('link', { name: 'Staffing' })).toHaveAttribute('href', '/people/staffing');
    expect(screen.queryByRole('link', { name: 'Directory' })).not.toBeInTheDocument();
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
});
