import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { forgetUnsaved, rememberUnsaved } from '../editorRecovery';
import { sampleDocument } from '../testFixtures';
import { EditorErrorBoundary } from './EditorErrorBoundary';

let broken = true;
function Editor({ recovered }: { recovered?: unknown }) {
  if (broken) throw new TypeError('boom');
  return <p>{recovered ? 'editor with edits' : 'editor'}</p>;
}

describe('EditorErrorBoundary', () => {
  it('shows the error instead of crashing, and restarts the editor', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    forgetUnsaved('wiref');
    broken = true;
    render(<EditorErrorBoundary kind="wiref">{(recovered) => <Editor recovered={recovered} />}</EditorErrorBoundary>);
    expect(screen.getByRole('alert')).toHaveTextContent('TypeError: boom');
    expect(screen.queryByRole('button', { name: /unsaved edits/ })).not.toBeInTheDocument();
    broken = false;
    await user.click(screen.getByRole('button', { name: 'Reload editor' }));
    expect(screen.getByText('editor')).toBeInTheDocument();
  });

  it('offers the unsaved edits back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    rememberUnsaved('cashbook', sampleDocument());
    broken = true;
    render(
      <EditorErrorBoundary kind="cashbook">{(recovered) => <Editor recovered={recovered} />}</EditorErrorBoundary>,
    );
    broken = false;
    await user.click(screen.getByRole('button', { name: 'Reload with my unsaved edits' }));
    expect(screen.getByText('editor with edits')).toBeInTheDocument();
    forgetUnsaved('cashbook');
  });
});
