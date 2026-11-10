import { useState } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderRoute } from '../../../test/render';
import { sceneFixture, mockSignage, blockFixture } from '../testFixtures';
import { toDraft, type Draft } from '../sceneDraft';
import { defaultWidget } from '../widgets';
import { PropertiesPanel } from './PropertiesPanel';

vi.mock('../../auth/auth', () => ({
  useCurrentUser: () => ({ permissions: [], authentication: { reauthenticationRequired: [] } }),
}));

type Call = { draft: Draft; key?: string };

function setup(
  blocks: ReturnType<typeof blockFixture>[],
  selectedIds: string[],
  { canEdit = true, aspect = { width: 16, height: 9 } } = {},
) {
  mockSignage([]);
  const calls: Call[] = [];
  const selections: string[][] = [];
  const initial = toDraft(sceneFixture({ aspectRatio: aspect, blocks }));
  function Harness() {
    const [draft, setDraft] = useState(initial);
    return (
      <PropertiesPanel
        draft={draft}
        selectedIds={selectedIds}
        canEdit={canEdit}
        onChange={(next, key) => {
          calls.push({ draft: next, key });
          setDraft(next);
        }}
        onSelect={(ids) => selections.push(ids)}
        overflowIds={new Set(['b1'])}
        shownOn={[
          { id: 'd1', name: 'Entrance', aspectLabel: '16:9', sameShape: true },
          { id: 'd2', name: 'Hallway', detail: 'Group', aspectLabel: '9:16', sameShape: false },
        ]}
        snapping
        onSnappingChange={() => undefined}
      />
    );
  }
  renderRoute(<Harness />);
  return { calls, selections, last: () => calls[calls.length - 1] };
}

const textBlock = (id: string, x = 100, textSize = 50) =>
  blockFixture(id, { x, y: 100, w: 400, h: 200 }, defaultWidget('text'), { textSize });

describe('PropertiesPanel', () => {
  it('shows the sections of one block and the overflow warning', () => {
    setup([textBlock('b1')], ['b1']);
    for (const name of ['Content', 'Position and size', 'Fill', 'Border and shadow', 'Text', 'Block'])
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    expect(screen.getByText('Content does not fit')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'b1' })).toBeInTheDocument();
    expect(screen.queryByText(/px/)).not.toBeInTheDocument();
  });

  it('emits the edited text size, background and border with a coalesce key', () => {
    const t = setup([textBlock('b1')], ['b1']);
    fireEvent.change(screen.getByLabelText('Text size'), { target: { value: '72' } });
    expect(t.last().key).toBe('b1:style.textSize');
    expect(t.last().draft.blocks[0].style.textSize).toBe(72);
    fireEvent.change(screen.getByLabelText('Background colour'), { target: { value: '#FF0000' } });
    expect(t.last().key).toBe('b1:style.backgroundColor');
    expect(t.last().draft.blocks[0].style.backgroundColor).toBe('#ff0000');
    fireEvent.change(screen.getByLabelText('Border width'), { target: { value: '4' } });
    expect(t.last().key).toBe('b1:style.borderWidth');
    expect(t.last().draft.blocks[0].style).toMatchObject({ borderWidth: 4, backgroundColor: '#ff0000', textSize: 72 });
  });

  it('edits the position and the shrink-to-fit toggle of a text block', async () => {
    const t = setup([textBlock('b1')], ['b1']);
    fireEvent.change(screen.getByLabelText('X'), { target: { value: '240' } });
    expect(t.last().draft.blocks[0].x).toBe(240);
    expect(t.last().key).toBe('b1:geometry.x');
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Shrink text to fit' }));
    expect(t.last().draft.blocks[0].widget).toMatchObject({ type: 'text', fit: true });
  });

  it('hides the background image for media widgets and darkens an image', () => {
    const image = blockFixture('b1', { x: 0, y: 0, w: 800, h: 450 }, defaultWidget('image'));
    const t = setup([image], ['b1']);
    expect(screen.queryByText('Background image')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Darken image', { selector: 'input[type="number"]' }), {
      target: { value: '40' },
    });
    expect(t.last().draft.blocks[0].widget).toMatchObject({ type: 'image', dim: 40 });
    expect(t.last().draft.blocks[0].style.backgroundDim).toBe(0);
  });

  it('shows the background image for other widgets', () => {
    setup([textBlock('b1')], ['b1']);
    expect(screen.getByText('Background image')).toBeInTheDocument();
  });

  it('switches camera overlays', async () => {
    const camera = blockFixture('b1', { x: 0, y: 0, w: 960, h: 540 }, defaultWidget('camera'));
    const t = setup([camera], ['b1']);
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Show the live picture' }));
    expect(t.last().draft.blocks[0].widget).toMatchObject({ type: 'camera', showLive: false, showName: true });
  });

  it('shows Mixed for differing values and aligns several blocks', async () => {
    const t = setup([textBlock('b1', 100, 40), textBlock('b2', 700, 60)], ['b1', 'b2']);
    expect(screen.getByRole('heading', { name: '2 blocks selected' })).toBeInTheDocument();
    expect(screen.getByLabelText('Text size')).toHaveAttribute('placeholder', 'Mixed');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Align left' }));
    expect(t.last().draft.blocks.map((b) => b.x)).toEqual([100, 100]);
    fireEvent.change(screen.getByLabelText('Text size'), { target: { value: '30' } });
    expect(t.last().key).toBe('multi:style.textSize');
    expect(t.last().draft.blocks.map((b) => b.style.textSize)).toEqual([30, 30]);
  });

  it('selects the copies after a mirrored copy', async () => {
    const t = setup([textBlock('b1'), textBlock('b2', 700)], ['b1', 'b2']);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Mirrored copy, left to right' }));
    expect(t.last().draft.blocks).toHaveLength(4);
    expect(t.selections.at(-1)).toHaveLength(4);
  });

  it('stretches the blocks when the screen shape changes', () => {
    const t = setup([textBlock('b1', 400)], []);
    expect(screen.getByRole('heading', { name: 'Screen' })).toBeInTheDocument();
    const width = screen.getByLabelText('Width part of the ratio');
    fireEvent.change(width, { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Height part of the ratio'), { target: { value: '3' } });
    expect(t.calls).toHaveLength(0);
    fireEvent.focusOut(width);
    expect(t.last().draft.aspectRatio).toEqual({ width: 4, height: 3 });
    // 1920x1080 becomes 1440x1080: x 400 -> 300, width 400 -> 300.
    expect(t.last().draft.blocks[0]).toMatchObject({ x: 300, w: 300, y: 100, h: 200 });
  });

  it('lists where the screen is shown and flags another shape', () => {
    setup([], []);
    expect(screen.getByText('Entrance')).toBeInTheDocument();
    expect(screen.getByText('Different shape')).toBeInTheDocument();
  });

  it('changes the theme of the screen', async () => {
    const t = setup([], []);
    await userEvent.setup().click(screen.getByLabelText('Dark text on the background'));
    expect(t.last().draft.theme).toBe('light');
  });

  it('closes by clearing the selection', async () => {
    const t = setup([textBlock('b1')], ['b1']);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close properties' }));
    expect(t.selections.at(-1)).toEqual([]);
  });

  it('has no editable inputs when read-only', () => {
    setup([textBlock('b1')], ['b1'], { canEdit: false });
    for (const input of [...screen.getAllByRole('textbox'), ...screen.getAllByRole('spinbutton')])
      expect(input).toBeDisabled();
    for (const toggle of screen.getAllByRole('switch')) expect(toggle).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset style' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Align left' })).toBeDisabled();
  });
});
