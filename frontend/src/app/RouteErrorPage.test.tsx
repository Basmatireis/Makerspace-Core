import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/http-client';
import { claimChunkReload, isChunkLoadError } from './chunkLoadRecovery';
import { rememberComponentStack } from './errorSummary';
import { RouteErrorPage } from './RouteErrorPage';

function renderWithError(error: unknown) {
  const Thrower = () => {
    throw error;
  };
  const router = createMemoryRouter([{ path: '*', element: <Thrower />, errorElement: <RouteErrorPage /> }]);
  return render(<RouterProvider router={router} />);
}

describe('RouteErrorPage', () => {
  const reload = vi.fn();
  const originalLocation = window.location;

  beforeEach(() => {
    window.sessionStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('location', { ...window.location, reload });
  });

  afterEach(() => {
    // Only location is restored: unstubbing every global would also remove the test setup's ResizeObserver.
    vi.stubGlobal('location', originalLocation);
    vi.restoreAllMocks();
    reload.mockReset();
  });

  it('recognizes stale chunk failures from each browser', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /assets/A-1.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: /assets/A-1.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
  });

  it('allows only one automatic reload within the window', () => {
    expect(claimChunkReload(1_000)).toBe(true);
    expect(claimChunkReload(5_000)).toBe(false);
    expect(claimChunkReload(20_000)).toBe(true);
  });

  it('reloads once automatically after a stale chunk failure', () => {
    renderWithError(new TypeError('error loading dynamically imported module: /assets/SalesOverviewPage-x.js'));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('Loading the latest version').length).toBeGreaterThan(0);
  });

  it('shows the update page instead of looping when the reload did not help', () => {
    claimChunkReload();
    renderWithError(new TypeError('error loading dynamically imported module: /assets/SalesOverviewPage-x.js'));

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'A new version is available' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
  });

  it('shows a generic error page for other failures without reloading', () => {
    renderWithError(new Error('boom'));

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute('href', '/dashboard');
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
    expect(screen.queryByText('Likely cause')).not.toBeInTheDocument();
  });

  it('shows an error code and reference and keeps the details collapsed', async () => {
    renderWithError(new Error('boom'));

    expect(screen.getByText(/^Error code/, { selector: 'p' })).toHaveTextContent(
      /Error code RENDER · Reference [A-Z2-9]{8} ·/,
    );
    expect(await screen.findByRole('button', { name: 'Technical details' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('copies sanitized details including the component stack', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const error = new Error('Failed for ada@example.org');
    rememberComponentStack(error, '\n    at CashbookEditor\n    at PdfTemplatesPage');
    renderWithError(error);

    await user.click(await screen.findByRole('button', { name: 'Copy details' }));

    const copied = writeText.mock.calls[0][0];
    expect(copied).toContain('Error code: RENDER');
    expect(copied).toContain('Error: Error: Failed for [email]');
    expect(copied).toContain('at CashbookEditor');
    expect(copied).not.toContain('ada@example.org');
    expect(screen.getByRole('button', { name: 'Details copied' })).toBeInTheDocument();
  });

  it('opens the details when copying is not allowed', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    renderWithError(new Error('boom'));

    await user.click(await screen.findByRole('button', { name: 'Copy details' }));

    expect(screen.getByText('Could not copy automatically.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Technical details' })).toHaveAttribute('aria-expanded', 'true'),
    );
  });

  it('names the status and request id of an API error', async () => {
    const user = userEvent.setup();
    renderWithError(new ApiError(502, { message: 'Bad gateway', requestId: 'req-7' }));

    expect(screen.getByText('API_502', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText(/failed to handle a request/)).toBeInTheDocument();
    const details = await screen.findByRole('button', { name: 'Technical details' });
    await user.click(details);
    expect(within(details.closest('li')!).getByText(/Request id: req-7/)).toBeInTheDocument();
  });
});
