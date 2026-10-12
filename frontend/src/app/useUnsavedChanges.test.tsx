import { useState } from 'react';
import { Button, Modal } from '@carbon/react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider, useNavigate } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';
import { useUnsavedChanges, type UseUnsavedChangesOptions } from './useUnsavedChanges';

function GuardHarness({ onDiscard = () => undefined, shouldBlockNavigation }: Pick<UseUnsavedChangesOptions, 'onDiscard' | 'shouldBlockNavigation'>) {
  const [dirty, setDirty] = useState(true);
  const navigate = useNavigate();
  const guard = useUnsavedChanges({ isDirty: dirty, onDiscard, shouldBlockNavigation });

  return (
    <>
      <p>Editor</p>
      <Button onClick={() => guard.requestDiscard(() => navigate('/closed'))}>Cancel editor</Button>
      <Button onClick={() => guard.requestDiscard(() => navigate('?tab=local'))}>Change local tab</Button>
      <Button onClick={() => navigate('?tab=settings')}>Settings tab</Button>
      <Button onClick={() => {
        setDirty(false);
        guard.bypassAfterSubmit(() => navigate('/saved'));
      }}>Save and leave</Button>
      <UnsavedChangesDialog guard={guard} />
    </>
  );
}

function renderHarness(onDiscard?: () => void, shouldBlockNavigation?: UseUnsavedChangesOptions['shouldBlockNavigation']) {
  const router = createMemoryRouter([
    { path: '/edit', element: <GuardHarness onDiscard={onDiscard} shouldBlockNavigation={shouldBlockNavigation} /> },
    { path: '/closed', element: <p>Closed</p> },
    { path: '/saved', element: <p>Saved</p> },
  ], { initialEntries: ['/edit?tab=overview'] });
  return { router, ...render(<RouterProvider router={router} />) };
}

describe('useUnsavedChanges', () => {
  it('uses current dirty state for Escape listeners installed before edits', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    function ModalHarness() {
      const [dirty, setDirty] = useState(false);
      const guard = useUnsavedChanges({ isDirty: dirty });
      return <>
        <Modal open={!guard.dialogOpen} modalHeading="Edit record" passiveModal
          onRequestClose={() => guard.requestDiscard(onClose)}>
          <Button onClick={() => setDirty(true)}>Make an edit</Button>
        </Modal>
        <UnsavedChangesDialog guard={guard} />
      </>;
    }
    const router = createMemoryRouter([{ path: '/', element: <ModalHarness /> }]);
    render(<RouterProvider router={router} />);
    await user.click(screen.getByRole('button', { name: 'Make an edit' }));
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('allows draft-preserving view navigation while still blocking a route exit', async () => {
    const user = userEvent.setup();
    const onDiscard = vi.fn();
    const { router } = renderHarness(onDiscard, (current, next) => current.pathname !== next.pathname);
    await user.click(screen.getByRole('button', { name: 'Settings tab' }));
    expect(router.state.location.search).toBe('?tab=settings');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onDiscard).not.toHaveBeenCalled();
    await router.navigate('/closed');
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/edit');
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('uses one discard dialog for local cancellation', async () => {
    const user = userEvent.setup();
    const onDiscard = vi.fn();
    renderHarness(onDiscard);

    await user.click(screen.getByRole('button', { name: 'Cancel editor' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(await screen.findByText('Closed')).toBeInTheDocument();
    expect(onDiscard).toHaveBeenCalledOnce();
  });

  it('guards query-only navigation on the same path', async () => {
    const user = userEvent.setup();
    const { router } = renderHarness();

    await user.click(screen.getByRole('button', { name: 'Settings tab' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?tab=overview');
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(router.state.location.search).toBe('?tab=overview');
  });

  it('bypasses the router guard once when a confirmed local action changes the query', async () => {
    const user = userEvent.setup();
    const onDiscard = vi.fn();
    const { router } = renderHarness(onDiscard);

    await user.click(screen.getByRole('button', { name: 'Change local tab' }));
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(router.state.location.search).toBe('?tab=local');
    expect(onDiscard).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('bypasses the guard after a successful submit', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByRole('button', { name: 'Save and leave' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('registers a beforeunload guard only while dirty', () => {
    renderHarness();
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
