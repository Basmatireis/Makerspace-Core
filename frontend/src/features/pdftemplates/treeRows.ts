import {
  containerKey,
  getContainer,
  innerOf,
  slotArray,
  slotsOf,
  type Container,
  type Root,
  type TemplateDocument,
  type TemplateNode,
} from './model';

/** One line of the structure tree. The tree is flattened so drag and drop and keyboard handling work on plain rows. */
export type TreeRow =
  | { kind: 'page'; key: string }
  | {
      kind: 'section';
      key: string;
      root: Root;
      title: string;
      description: string;
      count: number;
      open: boolean;
      container: Container;
    }
  | {
      kind: 'node';
      key: string;
      node: TemplateNode;
      depth: number;
      container: Container;
      index: number;
      /** The child list a drop on the middle of the row goes into. */
      inner: Container | null;
      open: boolean;
    }
  | { kind: 'branch'; key: string; label: string; depth: number; container: Container }
  | { kind: 'empty'; key: string; text: string; depth: number; container: Container };

export const SECTIONS: readonly { root: Root; title: string; description: string }[] = [
  { root: 'layers', title: 'Page layers', description: 'Fixed positions on chosen pages' },
  { root: 'header', title: 'Header', description: 'Top of every page' },
  { root: 'body', title: 'Body', description: 'Flows across pages' },
  { root: 'footer', title: 'Footer', description: 'Bottom of every page' },
];

/** Sections and containers start open, page layers closed; the person's toggles are kept by key. */
export const isOpen = (open: Readonly<Record<string, boolean>>, key: string, node?: TemplateNode): boolean =>
  open[key] ?? (node ? node.type !== 'layer' : true);

export function buildRows(doc: TemplateDocument, open: Readonly<Record<string, boolean>>): TreeRow[] {
  const rows: TreeRow[] = [{ kind: 'page', key: 'page' }];

  const nodeRows = (node: TemplateNode, depth: number, container: Container, index: number) => {
    const inner = innerOf(node);
    const shown = isOpen(open, node.id, node);
    rows.push({
      kind: 'node',
      key: node.id,
      node,
      depth,
      container,
      index,
      inner: inner ? { node: node.id, slot: inner } : null,
      open: inner ? shown : false,
    });
    if (!inner || !shown) return;
    for (const { slot, label } of slotsOf(node)) {
      const here: Container = { node: node.id, slot };
      const kids = slotArray(node, slot) ?? [];
      let childDepth = depth + 1;
      if (label) {
        rows.push({
          kind: 'branch',
          key: containerKey(here),
          label: `${label}${kids.length ? '' : ' · empty, drop blocks here'}`,
          depth: depth + 1,
          container: here,
        });
        childDepth = depth + 2;
      } else if (!kids.length) {
        rows.push({
          kind: 'empty',
          key: containerKey(here),
          text: node.type === 'layer' ? 'Empty · drop elements here' : 'Empty · drop blocks here',
          depth: depth + 1,
          container: here,
        });
      }
      kids.forEach((kid, i) => nodeRows(kid, childDepth, here, i));
    }
  };

  for (const { root, title, description } of SECTIONS) {
    const list = doc[root] as TemplateNode[];
    const container: Container = { root };
    const sectionOpen = isOpen(open, `sec:${root}`);
    rows.push({
      kind: 'section',
      key: `sec:${root}`,
      root,
      title,
      description,
      count: list.length,
      open: sectionOpen,
      container,
    });
    if (!sectionOpen) continue;
    list.forEach((node, i) => nodeRows(node, 0, container, i));
    if (!list.length)
      rows.push({
        kind: 'empty',
        key: `empty:${root}`,
        text: 'Empty · drop blocks here or use the insert bar',
        depth: 0,
        container,
      });
  }
  return rows;
}

export type DropKind = 'before' | 'after' | 'into';
export interface DropSpot {
  kind: DropKind;
  container: Container;
  index: number;
}

/**
 * Where a drop on a row goes. `fraction` is the pointer's height inside the row (0 top, 1 bottom): the top half is
 * before the row, the bottom half after it, the middle of a container row into it. Section, branch and empty rows
 * take drops into their own list, at the top.
 */
export function dropSpot(doc: TemplateDocument, row: TreeRow, fraction: number): DropSpot | null {
  if (row.kind === 'page') return null;
  if (row.kind !== 'node') return { kind: 'into', container: row.container, index: 0 };
  if (row.inner && fraction > 0.3 && fraction < 0.7)
    return { kind: 'into', container: row.inner, index: getContainer(doc, row.inner)?.length ?? 0 };
  return fraction < 0.5
    ? { kind: 'before', container: row.container, index: row.index }
    : { kind: 'after', container: row.container, index: row.index + 1 };
}

/** A row with the rows nested under it, for the `role="group"` markup of the tree. */
export interface TreeItem {
  row: TreeRow;
  children: TreeItem[];
}

/** Page and section rows sit above the depth of every other row. */
const depthOf = (row: TreeRow): number => (row.kind === 'page' || row.kind === 'section' ? -1 : row.depth);

/**
 * Nests the flat rows: a row's children are the rows after it that are deeper, up to the next row at its own depth or
 * above. The page row has none, a section has its blocks, a container block has its slots and blocks.
 */
export function nestRows(rows: readonly TreeRow[]): TreeItem[] {
  const top: TreeItem[] = [];
  const stack: { depth: number; item: TreeItem }[] = [];
  for (const row of rows) {
    const item: TreeItem = { row, children: [] };
    const depth = depthOf(row);
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    // The page row is never a parent: whatever follows it is a sibling.
    (stack.length ? stack[stack.length - 1].item.children : top).push(item);
    if (row.kind !== 'page') stack.push({ depth, item });
  }
  return top;
}
