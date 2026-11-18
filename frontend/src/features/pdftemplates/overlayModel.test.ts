import { describe, expect, it } from 'vitest';
import { hitTest, snapHalf } from './overlayModel';
import { layerElementId } from './model';
import { sampleDocument } from './testFixtures';

const box = (nodeId: string, page: number, x: number, y: number, w: number, h: number) => ({
  nodeId,
  page,
  x,
  y,
  w,
  h,
});

describe('hitTest', () => {
  const boxes = [box('cols', 1, 20, 40, 170, 30), box('inner', 1, 20, 40, 80, 10), box('other', 2, 0, 0, 300, 300)];
  it('picks the smallest box under the point on that page', () => {
    expect(hitTest(boxes, 1, 30, 45)?.nodeId).toBe('inner');
    expect(hitTest(boxes, 1, 150, 60)?.nodeId).toBe('cols');
    expect(hitTest(boxes, 2, 5, 5)?.nodeId).toBe('other');
    expect(hitTest(boxes, 1, 5, 5)).toBeNull();
  });
  it('prefers the later box among equals', () => {
    expect(hitTest([box('a', 1, 0, 0, 10, 10), box('b', 1, 0, 0, 10, 10)], 1, 5, 5)?.nodeId).toBe('b');
  });
  it('lets a hairline be hit within a little distance', () => {
    const line = [box('rule', 1, 20, 100, 100, 0)];
    expect(hitTest(line, 1, 50, 100.6)?.nodeId).toBe('rule');
    expect(hitTest(line, 1, 50, 103)).toBeNull();
  });
  it('snaps to half millimetres', () => {
    expect(snapHalf(3.3)).toBe(3.5);
    expect(snapHalf(3.2)).toBe(3);
  });
});

describe('layerElementId', () => {
  it('resolves nested nodes to the element of the layer', () => {
    const doc = sampleDocument();
    if (doc.layers[0].elements[0].type === 'rect')
      doc.layers[0].elements.push({
        id: 'box',
        type: 'box',
        padding: 2,
        stroke: 0.3,
        color: '#000',
        blocks: [{ id: 'in', type: 'text', text: 'x' }],
      });
    expect(layerElementId(doc, 'stamp')).toBe('stamp');
    expect(layerElementId(doc, 'in')).toBe('box');
    expect(layerElementId(doc, 'intro')).toBeNull();
    expect(layerElementId(doc, 'layer1')).toBeNull();
  });
});
