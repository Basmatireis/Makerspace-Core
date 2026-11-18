import { describe, expect, it } from 'vitest';
import { buildRows, dropSpot, isOpen, nestRows, type TreeItem } from './treeRows';
import { sampleDocument } from './testFixtures';

describe('buildRows', () => {
  const rows = buildRows(sampleDocument(), {});
  const keys = rows.map((r) => r.key);

  it('lists page setup, the four sections and the nodes in order, page layers closed', () => {
    expect(keys.slice(0, 3)).toEqual(['page', 'sec:layers', 'layer1']);
    expect(keys).not.toContain('stamp');
    expect(keys.indexOf('sec:header')).toBeLessThan(keys.indexOf('logo'));
    expect(keys.indexOf('title')).toBeLessThan(keys.indexOf('sec:footer'));
  });

  it('shows branch rows for conditions and columns, with their children one level deeper', () => {
    const then = rows.find((r) => r.key === 'cond/then');
    const note = rows.find((r) => r.key === 'note');
    expect(then).toMatchObject({ kind: 'branch', label: 'Then', depth: 1 });
    expect(note).toMatchObject({ kind: 'node', depth: 2 });
    expect(rows.find((r) => r.key === 'cond/else')).toMatchObject({ label: 'Else · empty, drop blocks here' });
    expect(rows.find((r) => r.key === 'price')).toMatchObject({ depth: 1 });
  });

  it('opens a layer and collapses sections on request', () => {
    const open = buildRows(sampleDocument(), { layer1: true, 'sec:body': false });
    const openKeys = open.map((r) => r.key);
    expect(openKeys).toContain('stamp');
    expect(openKeys).not.toContain('title');
    expect(open.find((r) => r.key === 'sec:body')).toMatchObject({ open: false, count: 5 });
  });

  it('marks empty sections and containers with a drop row', () => {
    const doc = sampleDocument();
    doc.footer = [];
    expect(buildRows(doc, {}).find((r) => r.key === 'empty:footer')).toBeDefined();
  });

  it('defaults to closed layers only', () => {
    expect(isOpen({}, 'sec:body')).toBe(true);
    expect(isOpen({}, 'x', { id: 'x', type: 'layer', pages: 'all', elements: [] })).toBe(false);
    expect(isOpen({ x: true }, 'x', { id: 'x', type: 'layer', pages: 'all', elements: [] })).toBe(true);
  });
});

describe('dropSpot', () => {
  const doc = sampleDocument();
  const rows = buildRows(doc, {});
  const row = (key: string) => rows.find((r) => r.key === key)!;

  it('places before and after a block', () => {
    expect(dropSpot(doc, row('intro'), 0.1)).toEqual({ kind: 'before', container: { root: 'body' }, index: 1 });
    expect(dropSpot(doc, row('intro'), 0.9)).toEqual({ kind: 'after', container: { root: 'body' }, index: 2 });
  });
  it('drops into a container row at the end of its first list when the pointer is in the middle', () => {
    expect(dropSpot(doc, row('cond'), 0.5)).toEqual({
      kind: 'into',
      container: { node: 'cond', slot: 'then' },
      index: 1,
    });
    expect(dropSpot(doc, row('cond'), 0.1)).toMatchObject({ kind: 'before' });
  });
  it('drops onto headings and branches into their list', () => {
    expect(dropSpot(doc, row('sec:footer'), 0.9)).toEqual({ kind: 'into', container: { root: 'footer' }, index: 0 });
    expect(dropSpot(doc, row('cond/else'), 0.5)).toMatchObject({
      kind: 'into',
      container: { node: 'cond', slot: 'else' },
    });
    expect(dropSpot(doc, row('page'), 0.5)).toBeNull();
  });
});

describe('nestRows', () => {
  const doc = sampleDocument();
  const rows = buildRows(doc, { layer1: true });
  const top = nestRows(rows);
  const keysOf = (items: TreeItem[]) => items.map((i) => i.row.key);

  it('puts page setup and the sections at the top, without children for the page', () => {
    expect(keysOf(top)).toEqual(['page', 'sec:layers', 'sec:header', 'sec:body', 'sec:footer']);
    expect(top[0].children).toEqual([]);
  });

  it('nests blocks under their section and elements under their layer', () => {
    const layers = top[1];
    expect(keysOf(layers.children)).toEqual(['layer1']);
    expect(keysOf(layers.children[0].children)).toContain('stamp');
  });

  it('keeps every row exactly once', () => {
    const count = (items: TreeItem[]): number => items.reduce((n, i) => n + 1 + count(i.children), 0);
    expect(count(top)).toBe(rows.length);
  });

  it('nests slot labels and the blocks under them inside their container block', () => {
    const cond = rows.find((r) => r.kind === 'node' && r.node.type === 'if');
    expect(cond).toBeTruthy();
    const find = (items: TreeItem[]): TreeItem | undefined =>
      items.reduce<TreeItem | undefined>(
        (hit, i) => hit ?? (i.row.key === cond!.key ? i : find(i.children)),
        undefined,
      );
    const item = find(top)!;
    expect(item.children.some((c) => c.row.kind === 'branch')).toBe(true);
  });
});
