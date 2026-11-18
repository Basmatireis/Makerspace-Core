import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { sampleDocument, sampleSchema } from '../../testFixtures';
import { ColorPopover } from './ColorPopover';
import { PanelProvider } from './PanelProvider';

/** Stands in for a surrounding modal (React handler) and for the editor's own keys (window listener). */
function Harness({ onAround, onWindowKey }: { onAround: () => void; onWindowKey: () => void }) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    window.addEventListener('keydown', onWindowKey);
    return () => window.removeEventListener('keydown', onWindowKey);
  }, [onWindowKey]);
  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div onKeyDown={(event) => event.key === 'Escape' && onAround()}>
      <PanelProvider doc={sampleDocument()} schema={sampleSchema()} onChange={() => undefined}>
        <ColorPopover
          open={open}
          value="#d0103a"
          onPick={() => undefined}
          onClose={() => setOpen(false)}
          trigger={
            <button type="button" onClick={() => setOpen(true)}>
              Colour
            </button>
          }
        />
      </PanelProvider>
    </div>
  );
}

describe('ColorPicker', () => {
  it('closes only itself on Escape: neither a dialog around it nor the editor keys see the key', async () => {
    const user = userEvent.setup();
    const onAround = vi.fn();
    const onWindowKey = vi.fn();
    render(<Harness onAround={onAround} onWindowKey={onWindowKey} />);
    expect(screen.getByRole('dialog', { name: 'Colour' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Colour' })).not.toBeInTheDocument();
    expect(onAround).not.toHaveBeenCalled();
    expect(onWindowKey).not.toHaveBeenCalled();
    // With the picker closed, Escape reaches them again.
    screen.getByRole('button', { name: 'Colour' }).focus();
    await user.keyboard('{Escape}');
    expect(onAround).toHaveBeenCalled();
    expect(onWindowKey).toHaveBeenCalled();
  });
});
