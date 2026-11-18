import { describe, expect, it } from 'vitest';
import { newId, schemaHints } from './blocks';
import { find, type Block, type TemplateDocument } from './model';
import {
  cloneWithNewIds,
  dragGeometry,
  duplicateNode,
  handlesFor,
  insertNew,
  layerForDrawing,
  moveBy,
  moveNode,
  nudgeNode,
  patchNode,
  removeNode,
  copyNode,
  pasteNode,
  renameNode,
} from './ops';
import { counter, sampleDocument, sampleSchema } from './testFixtures';

const hints = schemaHints(sampleSchema());
const ids = (list: readonly { id: string }[]) => list.map((n) => n.id);

describe('moveNode', () => {
  it('moves a block between sections and leaves the input document alone', () => {
    const doc = sampleDocument();
    const before = JSON.stringify(doc);
    const result = moveNode(doc, 'intro', { root: 'footer' }, 1)!;
    expect(ids(result.doc.footer)).toEqual(['pageno', 'intro']);
    expect(ids(result.doc.body)).not.toContain('intro');
    expect(result.select).toBe('intro');
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('adjusts the index when moving down inside one list', () => {
    const result = moveNode(sampleDocument(), 'title', { root: 'body' }, 3)!;
    expect(ids(result.doc.body)).toEqual(['intro', 'cond', 'title', 'rep', 'cols']);
  });

  it('does nothing when the node would stay put', () => {
    const doc = sampleDocument();
    expect(moveNode(doc, 'intro', { root: 'body' }, 1)).toBeNull();
    expect(moveNode(doc, 'intro', { root: 'body' }, 2)).toBeNull();
  });

  it('refuses a node inside itself and a layer in the body', () => {
    const doc = sampleDocument();
    expect(moveNode(doc, 'cond', { node: 'cond', slot: 'then' }, 0)).toBeNull();
    expect(moveNode(doc, 'layer1', { root: 'body' }, 0)).toBeNull();
  });

  it('wraps a block dropped among the layers into a new layer and positions it', () => {
    const result = moveNode(sampleDocument(), 'intro', { root: 'layers' }, 1)!;
    expect(result.doc.layers).toHaveLength(2);
    const layer = result.doc.layers[1];
    expect(layer.title).toBe('Layer for Text');
    expect(layer.pages).toBe('all');
    expect(layer.elements[0]).toMatchObject({ id: 'intro', x: 20, y: 40, w: 170 });
    expect(result.expand).toContain(layer.id);
  });

  it('gives a block dropped into a layer a position, and takes it away again in the flow', () => {
    const into = moveNode(sampleDocument(), 'intro', { node: 'layer1', slot: 'elements' }, 1)!;
    const moved = find(into.doc, 'intro')!.node as Block;
    expect(moved).toMatchObject({ x: 20, y: 40, w: 170 });
    const out = moveNode(into.doc, 'intro', { root: 'body' }, 0)!;
    expect(find(out.doc, 'intro')!.node).not.toHaveProperty('x');
    expect(find(out.doc, 'intro')!.node).not.toHaveProperty('w');
  });

  it('keeps the own size of positioned blocks that leave a layer', () => {
    const out = moveNode(sampleDocument(), 'stamp', { root: 'body' }, 0)!;
    expect(find(out.doc, 'stamp')!.node).toMatchObject({ w: 40, h: 10 });
    expect(find(out.doc, 'stamp')!.node).not.toHaveProperty('x');
  });

  it('merges a layer dropped into another layer and removes the emptied layer', () => {
    const doc = sampleDocument();
    const second = insertNew(doc, 'layer', { root: 'layers' }, 1, hints, { id: counter('l') })!;
    const withBlock = moveNode(second.doc, 'intro', { node: second.select!, slot: 'elements' }, 0)!;
    const merged = moveNode(withBlock.doc, second.select!, { node: 'layer1', slot: 'elements' }, 0)!;
    expect(merged.doc.layers.map((l) => l.id)).toEqual(['layer1']);
    expect(ids(merged.doc.layers[0].elements)).toEqual(['intro', 'stamp']);
    expect(merged.select).toBe('intro');
    expect(merged.notice).toBe('Merged into layer “Stamps”');
  });

  it('moves a nested block out of its parent', () => {
    const result = moveNode(sampleDocument(), 'note', { root: 'header' }, 0)!;
    expect(ids(result.doc.header)).toEqual(['note', 'logo']);
    expect((find(result.doc, 'cond')!.node as { then: Block[] }).then).toEqual([]);
  });
});

describe('moveBy', () => {
  it('swaps neighbours and stops at the ends', () => {
    const doc = sampleDocument();
    expect(ids(moveBy(doc, 'intro', -1)!.doc.body).slice(0, 2)).toEqual(['intro', 'title']);
    expect(moveBy(doc, 'title', -1)).toBeNull();
    expect(moveBy(doc, 'cols', 1)).toBeNull();
  });
});

describe('insertNew', () => {
  it('adds a block with linked styles at the index and selects it', () => {
    const result = insertNew(sampleDocument(), 'text', { root: 'body' }, 1, hints, { id: counter() })!;
    expect(ids(result.doc.body).slice(0, 3)).toEqual(['title', 'id1', 'intro']);
    expect(find(result.doc, 'id1')!.node).toMatchObject({ type: 'text', textStyle: 'body' });
    expect(result.select).toBe('id1');
    expect(result.notice).toBe('Text added to body');
  });

  it('draws an element into a layer at a spot and size', () => {
    const result = insertNew(sampleDocument(), 'rect', { node: 'layer1', slot: 'elements' }, 1, hints, {
      id: counter(),
      at: [33.5, 44],
      size: { w: 25, h: 12 },
    })!;
    expect(find(result.doc, 'id1')!.node).toMatchObject({ x: 33.5, y: 44, w: 25, h: 12 });
    expect(result.expand).toContain('layer1');
  });

  it('keeps the default size for a click and takes the drawn size for lines', () => {
    const click = insertNew(sampleDocument(), 'rect', { node: 'layer1', slot: 'elements' }, 1, hints, {
      id: counter(),
      at: [10, 10],
      size: { w: 0, h: 0 },
    })!;
    expect(find(click.doc, 'id1')!.node).toMatchObject({ w: 60, h: 0 });
    const line = insertNew(sampleDocument(), 'line', { node: 'layer1', slot: 'elements' }, 1, hints, {
      id: counter(),
      at: [10, 10],
      size: { w: 0, h: 30 },
    })!;
    expect(find(line.doc, 'id1')!.node).toMatchObject({ type: 'line', w: 0, h: 30 });
  });

  it('wraps a block inserted among the layers, and fills loops from the schema', () => {
    const result = insertNew(sampleDocument(), 'table', { root: 'layers' }, 0, hints, { id: counter() })!;
    const layer = result.doc.layers[0];
    expect(layer.type).toBe('layer');
    expect(layer.elements[0]).toMatchObject({
      type: 'table',
      source: 'items',
      as: 'item',
      columns: [{ value: '{{item.description}}' }],
    });
  });

  it('inserts layers only among the layers', () => {
    expect(insertNew(sampleDocument(), 'layer', { root: 'body' }, 0, hints)).toBeNull();
    const layer = insertNew(sampleDocument(), 'layer', { root: 'layers' }, 1, hints, { id: counter() })!;
    expect(layer.expand).toContain('id1');
  });

  it('presets page number and date as text blocks', () => {
    const r = insertNew(sampleDocument(), 'pagenum', { root: 'footer' }, 0, hints, { id: counter() })!;
    expect(find(r.doc, 'id1')!.node).toMatchObject({ type: 'text', text: 'Page {{page}} / {{pages}}' });
  });
});

describe('layerForDrawing', () => {
  it('uses the layer of the selection', () => {
    expect(layerForDrawing(sampleDocument(), 'stamp', 0).layerId).toBe('layer1');
    expect(layerForDrawing(sampleDocument(), 'layer1', 1).layerId).toBe('layer1');
  });
  it('creates one free-elements layer per page kind and reuses it', () => {
    const first = layerForDrawing(sampleDocument(), null, 0);
    expect(first.doc.layers.at(-1)).toMatchObject({ title: 'Free elements · first page', pages: 'first' });
    const again = layerForDrawing(first.doc, 'intro', 0);
    expect(again.layerId).toBe(first.layerId);
    expect(again.doc.layers).toHaveLength(2);
    const next = layerForDrawing(first.doc, null, 2);
    expect(next.doc.layers.at(-1)).toMatchObject({ pages: 'next' });
  });
});

describe('copies, removal and rename', () => {
  it('clones with new ids all the way down', () => {
    const doc = sampleDocument();
    const cond = find(doc, 'cond')!.node;
    const copy = cloneWithNewIds(cond, counter('c'));
    expect(copy.id).toBe('c1');
    expect((copy as { then: Block[] }).then[0].id).toBe('c2');
    expect(cond.id).toBe('cond');
  });

  it('duplicates after the original', () => {
    const result = duplicateNode(sampleDocument(), 'intro', counter('d'))!;
    expect(ids(result.doc.body).slice(0, 3)).toEqual(['title', 'intro', 'd1']);
    expect(result.select).toBe('d1');
  });

  it('removes a node with its children', () => {
    const result = removeNode(sampleDocument(), 'cond')!;
    expect(find(result.doc, 'cond')).toBeNull();
    expect(find(result.doc, 'note')).toBeNull();
    // The block after it takes the selection.
    expect(result.select).toBe(ids(sampleDocument().body)[ids(sampleDocument().body).indexOf('cond') + 1]);
  });

  it('pastes a copy with new ids after the selection, into a layer, or at the end of the body', () => {
    const doc = sampleDocument();
    const clip = copyNode(doc, 'intro')!;
    const after = pasteNode(doc, clip, 'intro')!;
    const body = ids(after.doc.body);
    expect(body).toHaveLength(ids(doc.body).length + 1);
    expect(body.indexOf(after.select!)).toBe(body.indexOf('intro') + 1);
    expect(after.select).not.toBe('intro');
    const end = pasteNode(doc, clip, null)!;
    expect(end.doc.body.at(-1)?.id).toBe(end.select);
    const into = pasteNode(doc, clip, 'layer1')!;
    const layer = find(into.doc, 'layer1')!.node;
    expect(layer.type === 'layer' && layer.elements.at(-1)?.id).toBe(into.select);
    expect(find(into.doc, into.select!)!.area).toBe('layer');
    // A copied layer goes among the layers.
    const layerCopy = pasteNode(doc, copyNode(doc, 'layer1')!, 'intro')!;
    expect(layerCopy.doc.layers).toHaveLength(doc.layers.length + 1);
  });

  it('renames, clears the title with empty text and ignores no-ops', () => {
    const doc = sampleDocument();
    expect(find(renameNode(doc, 'intro', '  Greeting ')!, 'intro')!.node.title).toBe('Greeting');
    expect(find(renameNode(doc, 'layer1', '')!, 'layer1')!.node).not.toHaveProperty('title');
    expect(renameNode(doc, 'layer1', 'Stamps')).toBeNull();
    expect(renameNode(doc, 'nope', 'x')).toBeNull();
  });

  it('patches properties without touching the original', () => {
    const doc = sampleDocument();
    const next = patchNode(doc, 'stamp', { x: 5 })!;
    expect(find(next, 'stamp')!.node).toMatchObject({ x: 5, y: 30 });
    expect(find(doc, 'stamp')!.node).toMatchObject({ x: 20 });
  });

  it('generates ids that fit the id pattern', () => {
    expect(newId()).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
    expect(newId()).not.toBe(newId());
  });
});

describe('direct manipulation', () => {
  const start = { x: 20, y: 30, w: 40, h: 10 };

  it('moves with 0.5 mm snapping, free with Alt, locked to an axis with Shift', () => {
    expect(dragGeometry(start, 'move', 3.3, 1.1)).toMatchObject({ x: 23.5, y: 31 });
    expect(dragGeometry(start, 'move', 3.3, 1.1, { free: true })).toMatchObject({ x: 23.3, y: 31.1 });
    expect(dragGeometry(start, 'move', 3.3, 1.1, { axis: true })).toMatchObject({ x: 23.5, y: 30 });
    expect(dragGeometry(start, 'move', 0.4, -5, { axis: true })).toMatchObject({ x: 20, y: 25 });
  });

  it('resizes from the east and the north-west corner, keeping the opposite edge fixed', () => {
    expect(dragGeometry(start, 'e', 10, 99)).toEqual({ x: 20, y: 30, w: 50, h: 10 });
    expect(dragGeometry(start, 'nw', 5, 2)).toEqual({ x: 25, y: 32, w: 35, h: 8 });
  });

  it('never makes an element smaller than 1 mm', () => {
    expect(dragGeometry(start, 'w', 100, 0)).toMatchObject({ w: 1, x: 59 });
    expect(dragGeometry(start, 's', 0, -100).h).toBe(1);
  });

  it('chooses handles by block kind', () => {
    const doc = sampleDocument();
    expect(handlesFor(find(doc, 'stamp')!.node)).toHaveLength(8);
    expect(handlesFor(find(doc, 'intro')!.node)).toEqual(['w', 'e']);
    expect(handlesFor({ id: 'v', type: 'line', w: 0, h: 20, stroke: 0.3, color: '#000' })).toEqual(['n', 's']);
  });

  it('nudges only elements inside a layer', () => {
    const doc: TemplateDocument = sampleDocument();
    expect(find(nudgeNode(doc, 'stamp', 0.5, -5)!, 'stamp')!.node).toMatchObject({ x: 20.5, y: 25 });
    expect(nudgeNode(doc, 'intro', 1, 1)).toBeNull();
  });
});
