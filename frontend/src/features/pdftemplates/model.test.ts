import { describe as suite, expect, it } from 'vitest';
import {
  canDrop,
  containerKey,
  defaultTitle,
  describe,
  find,
  getContainer,
  innerOf,
  isInside,
  pageSize,
  paperLabel,
  places,
  subtreeIds,
  titleOf,
  walk,
} from './model';
import { sampleDocument } from './testFixtures';

suite('paper', () => {
  it('keeps portrait narrow and landscape wide', () => {
    const doc = sampleDocument();
    expect(pageSize(doc.page)).toEqual([210, 297]);
    expect(pageSize({ ...doc.page, orientation: 'landscape' })).toEqual([297, 210]);
    expect(pageSize({ ...doc.page, size: 'L62' })).toEqual([62, 100]);
  });
  it('uses the custom size, falling back to A4 values for missing numbers', () => {
    const doc = sampleDocument();
    expect(pageSize({ ...doc.page, size: 'custom', width: 400, height: 100 })).toEqual([100, 400]);
    expect(pageSize({ ...doc.page, size: 'custom' })).toEqual([210, 297]);
    expect(paperLabel({ ...doc.page, size: 'Letter' })).toBe('US Letter portrait · 215.9 × 279.4 mm');
  });
});

suite('traversal', () => {
  it('visits every node with its area, container and parent', () => {
    const doc = sampleDocument();
    const seen: Record<string, string> = {};
    walk(doc, (v) => (seen[v.node.id] = `${v.area}:${containerKey(v.container)}:${v.index}:${v.parent?.id ?? '-'}`));
    expect(seen.layer1).toBe('layers:root:layers:0:-');
    expect(seen.stamp).toBe('layer:layer1/elements:0:layer1');
    expect(seen.note).toBe('body:cond/then:0:cond');
    expect(seen.price).toBe('body:rep/blocks:0:rep');
    expect(seen.logo).toBe('header:root:header:0:-');
  });

  it('finds nodes and the layer they sit in', () => {
    const doc = sampleDocument();
    expect(find(doc, 'stamp')?.layer?.id).toBe('layer1');
    expect(find(doc, 'layer1')?.layer?.id).toBe('layer1');
    expect(find(doc, 'intro')?.layer).toBeNull();
    expect(find(doc, 'nope')).toBeNull();
  });

  it('resolves containers of the document and of nodes', () => {
    const doc = sampleDocument();
    expect(getContainer(doc, { root: 'footer' })?.[0].id).toBe('pageno');
    expect(getContainer(doc, { node: 'cond', slot: 'then' })?.[0].id).toBe('note');
    expect(getContainer(doc, { node: 'cols', slot: 'column:1' })).toEqual([]);
    expect(getContainer(doc, { node: 'cols', slot: 'column:2' })).toBeUndefined();
    expect(getContainer(doc, { node: 'intro', slot: 'blocks' })).toBeUndefined();
  });

  it('collects the subtree of a node', () => {
    const doc = sampleDocument();
    const cond = find(doc, 'cond')!.node;
    expect([...subtreeIds(cond)].sort()).toEqual(['cond', 'note']);
    expect(isInside(cond, { node: 'cond', slot: 'else' })).toBe(true);
    expect(isInside(cond, { node: 'cols', slot: 'column:0' })).toBe(false);
  });

  it('names the first child list of a container', () => {
    const doc = sampleDocument();
    expect(innerOf(find(doc, 'cond')!.node)).toBe('then');
    expect(innerOf(find(doc, 'cols')!.node)).toBe('column:0');
    expect(innerOf(find(doc, 'layer1')!.node)).toBe('elements');
    expect(innerOf(find(doc, 'intro')!.node)).toBeNull();
  });
});

suite('canDrop', () => {
  const doc = sampleDocument();
  it('refuses a node inside itself', () => {
    expect(canDrop(doc, { id: 'cond', type: 'if' }, { node: 'cond', slot: 'then' })).toBe(false);
    expect(canDrop(doc, { id: 'rep', type: 'repeat' }, { node: 'price', slot: 'blocks' })).toBe(false);
  });
  it('lets blocks go anywhere, including among the layers', () => {
    expect(canDrop(doc, { id: 'intro', type: 'text' }, { root: 'layers' })).toBe(true);
    expect(canDrop(doc, { id: 'intro', type: 'text' }, { node: 'cols', slot: 'column:1' })).toBe(true);
    expect(canDrop(doc, { type: 'rect' }, { root: 'footer' })).toBe(true);
  });
  it('keeps layers among the layers or merges them into another layer', () => {
    expect(canDrop(doc, { id: 'layer1', type: 'layer' }, { root: 'body' })).toBe(false);
    expect(canDrop(doc, { id: 'layer1', type: 'layer' }, { root: 'layers' })).toBe(true);
    expect(canDrop(doc, { id: 'layer1', type: 'layer' }, { node: 'layer1', slot: 'elements' })).toBe(false);
    expect(canDrop(doc, { type: 'layer' }, { root: 'layers' })).toBe(true);
    expect(canDrop(doc, { type: 'layer' }, { root: 'header' })).toBe(false);
  });
  it('refuses a container that does not exist', () => {
    expect(canDrop(doc, { type: 'text' }, { node: 'gone', slot: 'blocks' })).toBe(false);
  });
});

suite('titles and descriptions', () => {
  it('names loops after their source and columns after their count', () => {
    const doc = sampleDocument();
    expect(defaultTitle(find(doc, 'rep')!.node)).toBe('Repeat: items');
    expect(defaultTitle(find(doc, 'cols')!.node)).toBe('2 columns');
    expect(titleOf(find(doc, 'layer1')!.node)).toBe('Stamps');
    expect(titleOf(find(doc, 'intro')!.node)).toBe('Text');
  });
  it('describes the kind on a second line, with the position of layer elements', () => {
    const doc = sampleDocument();
    expect(describe(find(doc, 'stamp')!.node)).toMatchObject({
      l1: 'Rectangle',
      l2: 'Rectangle · x 20 y 30 mm',
      untitled: true,
    });
    expect(describe(find(doc, 'cond')!.node).l2).toBe('Condition · if request.note is set');
    expect(describe(find(doc, 'title')!.node)).toMatchObject({ strong: true, l2: 'Heading · 17 pt' });
    expect(describe(find(doc, 'layer1')!.node).l2).toBe('Page layer · Every page · 1 elements');
  });
  it('shows spacers and dividers on a slim line', () => {
    const doc = sampleDocument();
    doc.body.push({ id: 'sp', type: 'spacer', height: 4 });
    expect(describe(find(doc, 'sp')!.node)).toEqual({ l1: 'Space · 4 mm', compact: true });
  });
});

suite('places', () => {
  it('lists every container, with the lists nested in blocks', () => {
    const labels = places(sampleDocument()).map((p) => p.label);
    expect(labels).toContain('Layer “Stamps”');
    expect(labels).toContain('New page layer');
    expect(labels).toContain(
      'Body › Condition: request.note is set'.replace('Condition: request.note is set', 'Condition') + ' › Then',
    );
    expect(labels).toContain('Body › 2 columns › Column 2');
    expect(labels).toContain('Footer');
  });
  it('leaves out places inside the node that moves, and limits layers to the layer list', () => {
    const doc = sampleDocument();
    const keys = places(doc, 'cond').map((p) => containerKey(p.container));
    expect(keys).not.toContain('cond/then');
    expect(keys).toContain('root:body');
    expect(places(doc, 'layer1')).toEqual([{ label: 'Page layers', container: { root: 'layers' } }]);
  });
});
