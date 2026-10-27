import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimChunkReload, isChunkLoadError } from './chunkLoadRecovery';
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

  beforeEach(() => {
    window.sessionStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('location', { ...window.location, reload });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
  });
});
