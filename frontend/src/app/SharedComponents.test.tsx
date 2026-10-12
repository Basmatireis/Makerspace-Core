import { useRef, useState } from 'react';
import { Button, StructuredListBody, StructuredListWrapper } from '@carbon/react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderRoute } from '../test/render';
import { DestructiveActionDialog } from './DestructiveActionDialog';
import { DetailRow, DetailSection } from './DetailSection';
import { EmptyState } from './PageState';
import { RowActions } from './RowActions';

describe('shared application components', () => {
  it('renders reusable detail layout without changing the Directory class contract', () => {
    const { container } = renderRoute(
      <DetailSection title="Contact" description="How to reach this person" action={<Button>Edit</Button>}>
        <StructuredListWrapper>
          <StructuredListBody>
            <DetailRow label="Email" value="person@example.test" monospace />
          </StructuredListBody>
        </StructuredListWrapper>
      </DetailSection>,
    );

    expect(screen.getByRole('heading', { name: 'Contact' })).toBeInTheDocument();
    expect(screen.getByText('person@example.test').closest('code')).toBeInTheDocument();
    expect(container.querySelector('.detail-section')).toHaveClass('person-detail-card');
  });

  it('groups visible row actions under an accessible label', () => {
    renderRoute(
      <RowActions label="Actions for Ada Lovelace">
        <Button kind="ghost" size="sm">Edit</Button>
        <Button kind="danger--ghost" size="sm">Delete</Button>
      </RowActions>,
    );

    const actions = screen.getByRole('group', { name: 'Actions for Ada Lovelace' });
    expect(within(actions).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(actions).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('renders an optional empty-state action', () => {
    renderRoute(
      <EmptyState
        title="Nothing here"
        description="Create the first item."
        action={<Button>Create item</Button>}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Nothing here' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create item' })).toBeInTheDocument();
  });
});

describe('DestructiveActionDialog', () => {
  it('blocks Escape when a mutation starts after the dialog has opened', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    function Harness() {
      const [pending, setPending] = useState(false);
      return <DestructiveActionDialog open title="Remove record?" confirmLabel="Remove record"
        pending={pending} onClose={onClose} onConfirm={() => setPending(true)}>
        <p>The selected record will be removed.</p>
      </DestructiveActionDialog>;
    }
    renderRoute(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Remove record' }));
    expect(screen.getByRole('button', { name: 'Remove record…' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('restores focus when a selected-record dialog is unmounted on cancel', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <Button onClick={() => setOpen(true)}>Remove selected record</Button>
        {open && <DestructiveActionDialog
          open
          title="Remove record?"
          confirmLabel="Remove record"
          onClose={() => setOpen(false)}
          onConfirm={() => setOpen(false)}
        ><p>The selected record will be removed.</p></DestructiveActionDialog>}
      </>;
    }
    renderRoute(<Harness />);
    const launcher = screen.getByRole('button', { name: 'Remove selected record' });
    await user.click(launcher);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(launcher).toHaveFocus());
  });

  it('focuses cancel, leaves no closed actions, and restores launcher focus', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      const launcherRef = useRef<HTMLButtonElement>(null);
      return <>
        <Button ref={launcherRef} onClick={() => setOpen(true)}>Open delete dialog</Button>
        <DestructiveActionDialog
          open={open}
          title="Delete person?"
          confirmLabel="Delete person"
          launcherButtonRef={launcherRef}
          onClose={() => { onClose(); setOpen(false); }}
          onConfirm={onConfirm}
        >
          <p>This permanently removes the profile.</p>
        </DestructiveActionDialog>
      </>;
    }
    renderRoute(<Harness />);

    const launcher = screen.getByRole('button', { name: 'Open delete dialog' });
    expect(screen.queryByRole('button', { name: 'Delete person' })).not.toBeInTheDocument();
    await user.click(launcher);
    const dialog = await screen.findByRole('alertdialog');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(cancel).toHaveFocus());
    await user.click(cancel);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Delete person' })).not.toBeInTheDocument();
    await waitFor(() => expect(launcher).toHaveFocus());
  });

  it('keeps the dialog open and reports an error while a request is pending', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    renderRoute(
      <DestructiveActionDialog
        open
        title="Delete person?"
        confirmLabel="Delete person"
        pending
        error="The person could not be deleted."
        onClose={onClose}
        onConfirm={onConfirm}
      >
        <p>This permanently removes the profile.</p>
      </DestructiveActionDialog>,
    );

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: 'Delete person…' })).toBeDisabled();
    expect(within(dialog).getByText('The person could not be deleted.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
