import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { sampleDocument } from '../testFixtures';
import { StructureTree } from './StructureTree';

function Tree({ selected = null }: { selected?: string | null }) {
  const doc = sampleDocument();
  doc.styles.sizes.push({ id: 'gapXS', name: 'Gap XS', value: 2, unit: 'mm' });
  doc.body.push({ id: 'sp', type: 'spacer', height: '$s:gapXS' });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <StructureTree
      doc={doc}
      selectedId={selected}
      open={open}
      tool={null}
      errorIds={new Set()}
      onToggle={(key, value) => setOpen((now) => ({ ...now, [key]: value }))}
      onSelect={() => undefined}
      onHover={() => undefined}
      onMove={() => undefined}
      onMoveBy={() => undefined}
      onRename={() => undefined}
      onInsert={() => undefined}
    />
  );
}

const items = () => screen.getAllByRole('treeitem');

describe('StructureTree', () => {
  it('has a single tab stop: the selected row, else the first', () => {
    const { unmount } = render(<Tree selected="intro" />);
    expect(items().filter((i) => i.tabIndex === 0)).toHaveLength(1);
    expect((document.querySelector('[data-row-key="intro"]') as HTMLElement).tabIndex).toBe(0);
    unmount();
    render(<Tree />);
    expect(items().filter((i) => i.tabIndex === 0)).toEqual([items()[0]]);
  });

  it('moves focus with the arrow keys, Home and End, and the tab stop follows', async () => {
    const user = userEvent.setup();
    render(<Tree />);
    items()[0].focus();
    await user.keyboard('{ArrowDown}');
    expect(items()[1]).toHaveFocus();
    expect(items()[1].tabIndex).toBe(0);
    expect(items()[0].tabIndex).toBe(-1);
    await user.keyboard('{End}');
    expect(items().at(-1)).toHaveFocus();
    await user.keyboard('{Home}');
    expect(items()[0]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(items()[0]).toHaveFocus();
  });

  it('exposes level, set size and position, and nests children in a group', () => {
    render(<Tree />);
    const sections = items().filter((i) => i.getAttribute('aria-level') === '1');
    expect(sections).toHaveLength(5);
    expect(sections[1]).toHaveAttribute('aria-posinset', '2');
    expect(sections[1]).toHaveAttribute('aria-setsize', '5');
    const body = screen.getByRole('treeitem', { name: /^Body/ });
    // The treeitem owns its group, which sits next to it inside a presentational list item.
    const group = document.getElementById(body.getAttribute('aria-owns')!)!;
    expect(group).toHaveAttribute('role', 'group');
    expect(group.previousElementSibling).toBe(body);
    const child = within(group).getAllByRole('treeitem')[0];
    expect(child).toHaveAttribute('aria-level', '2');
    expect(child).toHaveAttribute('aria-setsize');
    // No list item outside the tree pattern.
    for (const li of screen.getByRole('tree').querySelectorAll('li')) expect(li).toHaveAttribute('role', 'none');
  });

  it('expands with ArrowRight, collapses and goes to the parent with ArrowLeft', async () => {
    const user = userEvent.setup();
    render(<Tree />);
    const layers = screen.getByRole('treeitem', { name: /^Page layers/ });
    layers.focus();
    await user.keyboard('{ArrowLeft}');
    expect(layers).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{ArrowRight}');
    expect(layers).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{ArrowRight}');
    const group = document.getElementById(layers.getAttribute('aria-owns')!)!;
    const first = within(group).getAllByRole('treeitem')[0];
    expect(first).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(layers).toHaveFocus();
  });

  it('shows the name and value of a size style, not its token', () => {
    render(<Tree />);
    expect(screen.getByText('Space · Gap XS (2 mm)')).toBeInTheDocument();
    expect(screen.queryByText(/\$s:/)).not.toBeInTheDocument();
  });

  it('describes how to move rows', () => {
    render(<Tree />);
    expect(screen.getByRole('tree')).toHaveAccessibleDescription(/Alt\+↑\/↓.*Move to…/);
  });
});
