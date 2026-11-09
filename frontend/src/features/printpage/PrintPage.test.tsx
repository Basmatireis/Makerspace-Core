import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrintPage as PrintPageData } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { printPageQuery } from './queries';

const runId = '0192f6f8-743e-7c77-a349-cd07c3e8f001';
const previewId = '0192f6f8-743e-7c77-a349-cd07c3e8f002';

const page: PrintPageData = {
  runId,
  displayId: 'RN-2026-000042',
  title: 'Gearbox housing',
  machineName: 'Prusa CORE One',
  startedAt: '2026-11-05T08:00:00Z',
  endedAt: '2026-11-05T11:30:00Z',
  durationSeconds: 12600,
  outcome: 'successful',
  timelapse: { sizeBytes: 31_457_280, mimeType: 'video/mp4', expiresAt: '2026-12-05T11:30:00Z' },
  timelapseStatus: { state: 'available', reason: null, detail: null },
  artifact: { originalFileName: 'gearbox.3mf', sizeBytes: 2_097_152 },
  previews: [{ id: previewId, role: 'plate', plateNumber: 1, primary: true }],
  viewerIsStaff: false,
};

function serve(body: PrintPageData | 'not-found') {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture())),
    http.get(`*/api/v1/print-pages/${runId}`, () =>
      body === 'not-found'
        ? HttpResponse.json({ code: 'not_found', message: 'Not found' }, { status: 404 })
        : HttpResponse.json(body),
    ),
  );
}

afterEach(() => vi.useRealTimers());

describe('print page', () => {
  it('shows the timelapse, downloads and facts without the application shell', async () => {
    serve(page);
    const { container } = renderRoute(<App />, `/prints/${runId}`);

    expect(await screen.findByRole('heading', { level: 1, name: /Gearbox housing/ })).toBeInTheDocument();
    expect(screen.getByText(/Your print · finished 05\.11\.2026/)).toBeInTheDocument();
    expect(screen.getByText('Successful')).toBeInTheDocument();
    const video = screen.getByLabelText('Timelapse of Gearbox housing');
    expect(video).toHaveAttribute('src', `/api/v1/print-pages/${runId}/timelapse/content`);
    expect(video).toHaveAttribute('preload', 'metadata');
    expect(screen.getByRole('link', { name: 'Download timelapse' })).toHaveAttribute(
      'href',
      `/api/v1/print-pages/${runId}/timelapse/content`,
    );
    expect(screen.getByRole('link', { name: /Download gearbox\.3mf/ })).toHaveAttribute(
      'href',
      `/api/v1/print-pages/${runId}/file/content`,
    );
    expect(screen.getByText('30 MB')).toBeInTheDocument();
    expect(screen.getByText('Prusa CORE One')).toBeInTheDocument();
    expect(screen.getByText('3 h 30 min')).toBeInTheDocument();
    expect(screen.getByText(/The timelapse is kept until 05\.12\.2026/)).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Plate 1 preview/ })).toHaveAttribute(
      'src',
      `/api/v1/print-pages/${runId}/previews/${previewId}/content`,
    );
    // Outside the shell: no side navigation.
    expect(container.querySelector('.cds--side-nav')).toBeNull();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('says "Print" instead of "Your print" for staff', async () => {
    serve({ ...page, viewerIsStaff: true });
    renderRoute(<App />, `/prints/${runId}`);
    expect(await screen.findByText(/^Print · finished/)).toBeInTheDocument();
    expect(screen.queryByText(/Your print/)).not.toBeInTheDocument();
  });

  it('promises the timelapse while it is pending and polls every 15 seconds only then', async () => {
    serve({ ...page, timelapse: null, timelapseStatus: { state: 'pending', reason: null, detail: null } });
    renderRoute(<App />, `/prints/${runId}`);
    expect(await screen.findByText('The timelapse is on its way')).toBeInTheDocument();
    expect(screen.queryByLabelText('Timelapse of Gearbox housing')).not.toBeInTheDocument();

    const interval = printPageQuery(runId).refetchInterval as (query: { state: { data?: PrintPageData } }) => unknown;
    const pending = {
      ...page,
      timelapse: null,
      timelapseStatus: { state: 'pending' as const, reason: null, detail: null },
    };
    expect(interval({ state: { data: pending } })).toBe(15_000);
    expect(interval({ state: { data: page } })).toBe(false);
    expect(interval({ state: { data: { ...pending, timelapseStatus: null } } })).toBe(false);
    expect(interval({ state: {} })).toBe(false);
  });

  it('lets the preview take the place of a missing timelapse and lists only the file', async () => {
    serve({ ...page, timelapse: null, timelapseStatus: { state: 'not_found', reason: null, detail: null } });
    renderRoute(<App />, `/prints/${runId}`);
    expect(await screen.findByRole('heading', { level: 1, name: /Gearbox housing/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('Timelapse of Gearbox housing')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download timelapse' })).not.toBeInTheDocument();
    expect(screen.queryByText(/The timelapse is kept until/)).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Plate 1 preview/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Download gearbox\.3mf/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Download Timelapse/ })).not.toBeInTheDocument();
  });

  it('says so when the timelapse was deleted', async () => {
    serve({ ...page, timelapse: null, timelapseStatus: { state: 'expired', reason: null, detail: null } });
    renderRoute(<App />, `/prints/${runId}`);
    expect(await screen.findByText('The timelapse was deleted')).toBeInTheDocument();
  });

  it('shows the same unavailable view for every 404, without the title, and offers another account', async () => {
    serve('not-found');
    let signedOut = false;
    server.use(
      // Once signed out the session is gone, as on the server.
      http.get('*/api/v1/auth/me', () =>
        signedOut
          ? HttpResponse.json({ code: 'unauthenticated', message: 'Sign in' }, { status: 401 })
          : HttpResponse.json(currentUserFixture()),
      ),
      http.post('*/api/v1/auth/logout', () => {
        signedOut = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, `/prints/${runId}`);

    expect(
      await screen.findByRole('heading', { level: 1, name: "This print isn't available to you" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/ask a supervisor during an open day/)).toBeInTheDocument();
    expect(screen.queryByText('Gearbox housing')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign in with another account' }));
    await waitFor(() => expect(signedOut).toBe(true));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.state).toEqual({ from: `/prints/${runId}` });
  });

  it('sends a signed-out visitor to sign in and back to the print', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json({ code: 'unauthenticated', message: 'Sign in' }, { status: 401 }),
      ),
    );
    const { router } = renderRoute(<App />, `/prints/${runId}`);
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.state).toEqual({ from: `/prints/${runId}` });
  });
});
