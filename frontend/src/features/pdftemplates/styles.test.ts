import { describe, expect, it } from 'vitest';
import {
  addColor,
  addSize,
  addTextStyle,
  colorRef,
  countTextStyleUsage,
  countUsage,
  detachAll,
  newStyleId,
  removeColor,
  removeSize,
  removeTextStyle,
  resolveColor,
  resolveLength,
  sizeRef,
  updateColor,
} from './styles';
import type { TemplateDocument } from './model';
import { sampleDocument } from './testFixtures';

function styled(): TemplateDocument {
  const doc = sampleDocument();
  doc.styles.colors.push({ id: 'red', name: 'Red', value: '#d0103a' });
  doc.styles.sizes.push({ id: 'rule', name: 'Rule', value: 0.25, unit: 'mm' });
  doc.styles.text[0].color = '$c:red';
  doc.page.accent = '$c:red';
  doc.body.push(
    {
      id: 'tbl',
      type: 'table',
      source: 'items',
      as: 'item',
      repeatHeader: true,
      headerFill: '$c:red',
      headerRule: '$c:text',
      headerStyle: 'body',
      bodyStyle: 'body',
      columns: [{ header: 'A', value: '{{item.description}}', width: 1, align: 'left' }],
      totals: [],
    },
    { id: 'div', type: 'divider', stroke: '$s:rule', color: '$c:red' },
    { id: 'styled', type: 'text', text: 'x', textStyle: 'body' },
  );
  return doc;
}

describe('style resolution', () => {
  it('resolves references, transparent and missing styles', () => {
    const { styles } = styled();
    expect(resolveColor('$c:red', styles)).toBe('#d0103a');
    expect(resolveColor('#112233', styles)).toBe('#112233');
    expect(resolveColor('transparent', styles)).toBe('');
    expect(resolveColor(undefined, styles)).toBe('');
    expect(resolveColor('$c:gone', styles)).toBe('#ff00ff');
    expect(resolveLength('$s:rule', styles)).toBe(0.25);
    expect(resolveLength(3, styles)).toBe(3);
    expect(colorRef('$c:text', styles)?.name).toBe('Text');
    expect(colorRef('#fff', styles)).toBeUndefined();
    expect(sizeRef('$s:rule', styles)?.unit).toBe('mm');
  });
});

describe('usage counting', () => {
  it('counts uses in the page, blocks and text styles, but not the style list itself', () => {
    const doc = styled();
    // page accent, text style colour, table header fill, divider colour
    expect(countUsage(doc, '$c:red')).toBe(4);
    expect(countUsage(doc, '$c:text')).toBe(1);
    expect(countUsage(doc, '$s:rule')).toBe(1);
    expect(countUsage(doc, '$c:none')).toBe(0);
  });
  it('counts every property that names a text style', () => {
    const doc = styled();
    expect(countTextStyleUsage(doc, 'body')).toBe(3);
    expect(countTextStyleUsage(doc, 'other')).toBe(0);
  });
});

describe('detaching and deleting styles', () => {
  it('detachAll replaces every use with the given value and leaves the input alone', () => {
    const doc = styled();
    const next = detachAll(doc, '$c:red', '#d0103a');
    expect(countUsage(next, '$c:red')).toBe(0);
    expect(next.page.accent).toBe('#d0103a');
    expect(next.styles.text[0].color).toBe('#d0103a');
    expect(countUsage(doc, '$c:red')).toBe(4);
  });
  it('deleting a colour keeps what it showed and removes it from the list', () => {
    const next = removeColor(styled(), 'red');
    expect(next.styles.colors.map((c) => c.id)).toEqual(['text']);
    expect(next.page.accent).toBe('#d0103a');
    expect(countUsage(next, '$c:red')).toBe(0);
  });
  it('deleting a size keeps its number', () => {
    const next = removeSize(styled(), 'rule');
    expect(next.styles.sizes).toEqual([]);
    expect(next.body.find((b) => b.id === 'div')).toMatchObject({ stroke: 0.25 });
  });
  it('deleting a text style copies its values onto the blocks and clears the part styles', () => {
    const next = removeTextStyle(styled(), 'body');
    expect(next.styles.text).toEqual([]);
    const text = next.body.find((b) => b.id === 'styled');
    expect(text).toMatchObject({ size: 10, weight: 400, lineHeight: 1.4, color: '$c:red' });
    expect(text).not.toHaveProperty('textStyle');
    expect(next.body.find((b) => b.id === 'tbl')).not.toHaveProperty('headerStyle');
  });
  it('ignores unknown ids', () => {
    const doc = styled();
    expect(removeColor(doc, 'nope')).toBe(doc);
    expect(removeSize(doc, 'nope')).toBe(doc);
    expect(removeTextStyle(doc, 'nope')).toBe(doc);
  });
});

describe('adding styles', () => {
  it('adds a colour, text style and size with fresh valid ids', () => {
    let doc = styled();
    const c = addColor(doc, '#8a3ffc');
    doc = c.doc;
    const t = addTextStyle(doc);
    doc = t.doc;
    const s = addSize(doc);
    doc = s.doc;
    for (const id of [c.id, t.id, s.id]) expect(id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
    expect(new Set([c.id, t.id, s.id]).size).toBe(3);
    expect(doc.styles.colors.at(-1)).toMatchObject({ value: '#8a3ffc', name: 'Colour 3' });
    expect(doc.styles.text.at(-1)?.color).toBe('$c:text');
    expect(doc.styles.sizes.at(-1)).toMatchObject({ value: 5, unit: 'mm' });
  });
  it('updates a colour in place without touching the input', () => {
    const doc = styled();
    const next = updateColor(doc, 'red', { value: '#000000' });
    expect(next.styles.colors.find((c) => c.id === 'red')?.value).toBe('#000000');
    expect(doc.styles.colors.find((c) => c.id === 'red')?.value).toBe('#d0103a');
  });
  it('never reuses an id', () => {
    const doc = styled();
    expect(doc.styles.colors.map((c) => c.id)).not.toContain(newStyleId('c', doc.styles));
  });
});
