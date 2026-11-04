import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { server } from '../../test/server';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { hasPermission } from '../auth/permissions';
import { GuideProvider } from '../guides/GuideProvider';
import type { GuideDefinition } from '../guides/types';
import { HelpArticlePage } from './HelpArticlePage';
import { HelpPage } from './HelpPage';

const hoisted = vi.hoisted(() => ({ user: null as unknown }));

vi.mock('../auth/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/auth')>()),
  useCurrentUser: () => hoisted.user,
}));

vi.mock('../guides/content', () => {
  const base = { duration: '3 min', kind: 'tour' as const, demo: false, steps: [] };
  const guides: GuideDefinition[] = [
    {
      ...base,
      id: 'welcome',
      area: 'getting-started',
      title: 'Welcome tour',
      summary: 'Find your way.',
      requires: () => true,
    },
    {
      ...base,
      id: 'new-job',
      area: 'workshop' as const,
      kind: 'workflow' as const,
      demo: true,
      title: 'Record a job',
      summary: 'From machine to invoice.',
      requires: (user) => hasPermission(user, 'machine_jobs.read'),
    },
  ];
  return { guides };
});

function renderHelp(permissions: PermissionId[], route = '/help') {
  hoisted.user = currentUserFixture(permissions);
  return renderRoute(
    <GuideProvider>
      <Routes>
        <Route path="/help" element={<HelpPage />} />
        <Route path="/help/:articleId" element={<HelpArticlePage />} />
      </Routes>
    </GuideProvider>,
    route,
  );
}

describe('help center', () => {
  it('lists only what the person may use and hides empty areas', async () => {
    renderHelp([]);
    expect(await screen.findByRole('heading', { name: 'Getting started', level: 2 })).toBeInTheDocument();
    expect(await screen.findByText('Welcome tour')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Help, tours and demos/ })).toHaveLength(2); // card and menu
    expect(screen.queryByText('Record a job')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Workshop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Open days' })).not.toBeInTheDocument();
  });

  it('builds the topic menu from the permitted areas and articles only', async () => {
    renderHelp([]);
    const menu = await screen.findByRole('navigation', { name: 'Help topics' });
    expect(within(menu).getAllByRole('link', { name: 'Getting started' })).toHaveLength(2); // area and article
    expect(within(menu).getAllByRole('link', { name: 'Getting started' })[0]).toHaveAttribute(
      'href',
      '/help#getting-started',
    );
    expect(within(menu).getByRole('link', { name: 'Help, tours and demos' })).toHaveAttribute(
      'href',
      '/help/help-and-tours',
    );
    expect(within(menu).getByRole('link', { name: 'All help topics' })).toHaveAttribute('aria-current', 'page');
    expect(within(menu).queryByText('Workshop')).not.toBeInTheDocument();
    expect(within(menu).queryByText('Machines')).not.toBeInTheDocument();
  });

  it('shows a workflow demo and the workshop topics to someone with the permission', async () => {
    renderHelp([PermissionId.machine_jobsread, PermissionId.machinesread]);
    expect(await screen.findByRole('heading', { name: 'Workshop', level: 2 })).toBeInTheDocument();
    const card = (await screen.findByText('Record a job')).closest('.help-card') as HTMLElement;
    expect(within(card).getByText('Workflow · Demo')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Start Record a job' })).toBeInTheDocument();
    const menu = screen.getByRole('navigation', { name: 'Help topics' });
    expect(within(menu).getByRole('link', { name: 'Machines' })).toBeInTheDocument();
  });

  it('marks completed guides and finds articles with the search', async () => {
    server.use(
      http.get('*/api/v1/me/guides', () =>
        HttpResponse.json({ items: [{ guideId: 'welcome', status: 'completed', updatedAt: '2026-01-01T00:00:00Z' }] }),
      ),
    );
    const user = userEvent.setup();
    renderHelp([]);
    const card = (await screen.findByText('Welcome tour')).closest('.help-card') as HTMLElement;
    await waitFor(() => expect(within(card).getByText('Completed')).toBeInTheDocument());

    await user.type(screen.getByRole('searchbox', { name: 'Search help' }), 'demos');
    const results = await screen.findByRole('region', { name: 'Search results' });
    expect(within(results).getByRole('link', { name: /Help, tours and demos/ })).toHaveAttribute(
      'href',
      '/help/help-and-tours',
    );
    expect(within(results).queryByRole('link', { name: /^The side navigation/ })).not.toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox', { name: 'Search help' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search help' }), 'zzzz');
    expect(await screen.findByText(/Nothing in the help center matches/)).toBeInTheDocument();
  });

  it('resets the tour progress', async () => {
    const reset = vi.fn();
    server.use(
      http.delete('*/api/v1/me/guides', () => {
        reset();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderHelp([]);
    await user.click(await screen.findByRole('button', { name: 'Show the tours again' }));
    await waitFor(() => expect(reset).toHaveBeenCalled());
  });

  it('renders an article with the current topic selected, a related guide and the way back', async () => {
    renderHelp([], '/help/getting-started');
    expect(await screen.findByRole('heading', { name: 'The side navigation' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Help' })).toHaveAttribute('href', '/help');
    expect(await screen.findByRole('button', { name: /Start the related guide: Welcome tour/ })).toBeInTheDocument();
    const menu = screen.getByRole('navigation', { name: 'Help topics' });
    expect(within(menu).getAllByRole('link', { name: 'Getting started' })[1]).toHaveAttribute('aria-current', 'page');
    expect(within(menu).getByRole('link', { name: 'Help, tours and demos' })).not.toHaveAttribute('aria-current');
    const pager = screen.getByRole('navigation', { name: 'More articles' });
    expect(within(pager).getByRole('link', { name: /Next.*Help, tours and demos/ })).toHaveAttribute(
      'href',
      '/help/help-and-tours',
    );
  });

  it('shows the not-found page for an unknown article', async () => {
    renderHelp([], '/help/no-such-article');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
