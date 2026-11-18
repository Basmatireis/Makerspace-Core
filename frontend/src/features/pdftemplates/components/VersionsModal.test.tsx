import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from '../../../test/server';
import { VersionsModal } from './VersionsModal';

const stamp = '2026-11-01T10:00:00Z';
const version = (n: number, state: 'draft' | 'published' | 'archived') => ({
  id: `0190a0a0-0000-7000-8000-00000000000${n}`,
  version: n,
  state,
  revision: 1,
  createdAt: stamp,
  updatedAt: stamp,
  publishedAt: state === 'published' ? stamp : null,
  createdBy: 'Ada',
  publishedBy: null,
});

function mount() {
  server.use(
    http.get('*/api/v1/pdf-templates/wiref/versions', () =>
      HttpResponse.json([version(3, 'draft'), version(2, 'published'), version(1, 'archived')]),
    ),
  );
  const calls = { restore: vi.fn(), reset: vi.fn(), discard: vi.fn() };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <VersionsModal
        kind="wiref"
        templateName="Invoice request"
        onClose={() => undefined}
        onRestore={calls.restore}
        onReset={calls.reset}
        onDiscardDraft={calls.discard}
        busy={false}
        error={null}
      />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), calls };
}

describe('VersionsModal', () => {
  it('asks before restoring a version, and does nothing on Cancel', async () => {
    const { user, calls } = mount();
    await user.click(await screen.findByRole('button', { name: 'Restore as draft' }));
    expect(calls.restore).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Restore version 1 as the draft?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.restore).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Restore as draft' }));
    await user.click(screen.getByRole('button', { name: 'Restore as draft' }));
    expect(calls.restore).toHaveBeenCalledOnce();
  });

  it('asks before resetting to the built-in default', async () => {
    const { user, calls } = mount();
    await user.click(await screen.findByRole('button', { name: 'Reset to the built-in default' }));
    expect(calls.reset).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    expect(calls.reset).toHaveBeenCalledOnce();
  });

  it('asks before discarding the draft, in a danger dialog', async () => {
    const { user, calls } = mount();
    await user.click(await screen.findByRole('button', { name: 'Discard the saved draft' }));
    expect(calls.discard).not.toHaveBeenCalled();
    expect(document.querySelector('.cds--modal--danger')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(calls.discard).toHaveBeenCalledOnce();
  });
});
