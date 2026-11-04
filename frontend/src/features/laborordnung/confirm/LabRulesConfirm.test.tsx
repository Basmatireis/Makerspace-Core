import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser, LaborordnungStatus } from '../../../api/generated/models';
import { App } from '../../../app/App';
import { currentUserFixture } from '../../../test/fixtures';
import { renderRoute } from '../../../test/render';
import { server } from '../../../test/server';

vi.mock('../../../app/pdf/renderPdf', () => ({
  renderPdf: async (url: string, container: HTMLElement, _signal: AbortSignal, onFirstPage: () => void) => {
    container.textContent = `Mock PDF viewer ${url}`;
    onFirstPage();
  },
}));

const versionId = '0192f6f8-743e-7c77-a349-cd07c3e8a930';
const newVersionId = '0192f6f8-743e-7c77-a349-cd07c3e8a960';
const version = (id: string, humanRevision: string) => ({
  id,
  status: 'published' as const,
  humanRevision,
  pdfFileId: '0192f6f8-743e-7c77-a349-cd07c3e8a931',
  sha256: 'a'.repeat(64),
  effectiveAt: '2026-09-01T00:00:00Z',
  publishedAt: '2026-08-20T00:00:00Z',
  createdAt: '2026-08-20T00:00:00Z',
});

const outdated = (mode: 'warning' | 'blocking'): LaborordnungStatus => ({
  mode,
  state: 'outdated',
  actionRequired: true,
  currentVersion: version(versionId, '2026-09'),
  latestConfirmedVersion: null,
  latestConfirmedAt: null,
});
const confirmed: LaborordnungStatus = {
  mode: 'warning',
  state: 'current',
  actionRequired: false,
  currentVersion: version(versionId, '2026-09'),
  latestConfirmedVersion: version(versionId, '2026-09'),
  latestConfirmedAt: '2026-09-02T10:00:00Z',
};

/** Serves the session with a mutable Lab Rules status, as the API does once a confirmation was recorded. */
function mockSession(initial: LaborordnungStatus) {
  const state = { status: initial, confirmations: [] as unknown[] };
  server.use(
    http.get('*/api/v1/auth/me', () => {
      const user: CurrentUser = { ...currentUserFixture(), laborordnungStatus: state.status };
      return HttpResponse.json(user);
    }),
    http.get('*/api/v1/laborordnung/status/me', () => HttpResponse.json(state.status)),
    http.post('*/api/v1/laborordnung/confirmations/me', async ({ request }) => {
      const body = (await request.json()) as { versionId: string };
      state.confirmations.push(body);
      state.status = confirmed;
      return HttpResponse.json(confirmed);
    }),
  );
  return state;
}

const agree = /I have read the Lab Rules \(revision 2026-09\) and agree to follow them/;

describe('Lab Rules confirmation modal', () => {
  it('asks a warning-mode person to confirm, keeps Confirm disabled until the box is ticked and records it', async () => {
    const state = mockSession(outdated('warning'));
    const user = userEvent.setup();
    renderRoute(<App />, '/settings');

    const dialog = await screen.findByRole('dialog', { name: 'Lab Rules, revision 2026-09' });
    expect(await within(dialog).findByText(/Mock PDF viewer .*\/laborordnung\/versions\/.*\/pdf/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: agree }));
    await user.click(confirm);

    await waitFor(() => expect(state.confirmations).toEqual([{ versionId }]));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Lab Rules, revision 2026-09' })).not.toBeInTheDocument(),
    );
  });

  it('lets a warning-mode person postpone with Later for this page load', async () => {
    const state = mockSession(outdated('warning'));
    const user = userEvent.setup();
    renderRoute(<App />, '/settings');

    const dialog = await screen.findByRole('dialog', { name: 'Lab Rules, revision 2026-09' });
    await user.click(within(dialog).getByRole('button', { name: 'Later' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Lab Rules, revision 2026-09' })).not.toBeInTheDocument(),
    );
    expect(state.confirmations).toEqual([]);
  });

  it('cannot be dismissed in blocking mode', async () => {
    mockSession(outdated('blocking'));
    const user = userEvent.setup();
    renderRoute(<App />, '/settings');

    const dialog = await screen.findByRole('dialog', { name: 'Lab Rules, revision 2026-09' });
    expect(within(dialog).queryByRole('button', { name: 'Later' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(document.querySelector('.cds--modal') as HTMLElement);
    expect(screen.getByRole('dialog', { name: 'Lab Rules, revision 2026-09' })).toBeInTheDocument();
    expect(document.querySelector('.lab-rules-modal--blocking')).not.toBeNull();
    // Only confirming closes it.
    expect(within(dialog).getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });

  it('does not appear when nothing needs confirming', async () => {
    mockSession(confirmed);
    renderRoute(<App />, '/settings');

    expect(await screen.findByRole('button', { name: /profile menu/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Lab Rules, revision 2026-09' })).not.toBeInTheDocument();
  });

  it('loads the new revision when the confirmed one is outdated (409)', async () => {
    const state = mockSession(outdated('warning'));
    server.use(
      http.post('*/api/v1/laborordnung/confirmations/me', () => {
        state.status = { ...outdated('warning'), currentVersion: version(newVersionId, '2026-10') };
        return HttpResponse.json(
          { code: 'lab_rules_version_outdated', message: 'The Lab Rules changed' },
          { status: 409 },
        );
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings');

    const dialog = await screen.findByRole('dialog', { name: 'Lab Rules, revision 2026-09' });
    await user.click(within(dialog).getByRole('checkbox', { name: agree }));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    expect(await within(dialog).findByText('The Lab Rules changed')).toBeInTheDocument();
    const next = await within(dialog).findByRole('checkbox', { name: /revision 2026-10/ });
    expect(next).not.toBeChecked();
  });
});

describe('Lab Rules confirm page', () => {
  it('shows the rules outside the application shell and thanks the person after confirming', async () => {
    const state = mockSession(outdated('warning'));
    const user = userEvent.setup();
    renderRoute(<App />, '/lab-rules/confirm');

    expect(await screen.findByRole('heading', { name: 'Lab Rules' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('checkbox', { name: agree }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText('You confirmed revision 2026-09 of the Lab Rules.')).toBeInTheDocument();
    expect(state.confirmations).toEqual([{ versionId }]);
    expect(screen.getByRole('link', { name: 'Open the app' })).toHaveAttribute('href', '/dashboard');
  });

  it('says so when the Lab Rules are already confirmed', async () => {
    mockSession(confirmed);
    renderRoute(<App />, '/lab-rules/confirm');

    expect(await screen.findByText('Already confirmed')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('says so when nothing needs to be confirmed', async () => {
    mockSession({
      mode: 'not_required',
      state: 'not_required',
      actionRequired: false,
      currentVersion: null,
      latestConfirmedVersion: null,
      latestConfirmedAt: null,
    });
    renderRoute(<App />, '/lab-rules/confirm');

    expect(await screen.findByText('Nothing to confirm')).toBeInTheDocument();
  });

  it('says so when no Lab Rules have been published', async () => {
    mockSession({
      mode: 'warning',
      state: 'no_published_version',
      actionRequired: false,
      currentVersion: null,
      latestConfirmedVersion: null,
      latestConfirmedAt: null,
    });
    renderRoute(<App />, '/lab-rules/confirm');

    expect(await screen.findByText('No Lab Rules yet')).toBeInTheDocument();
  });

  it('sends a signed-out person to the sign-in page and remembers the way back', async () => {
    const { router } = renderRoute(<App />, '/lab-rules/confirm');

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.state).toEqual({ from: '/lab-rules/confirm' });
  });
});
