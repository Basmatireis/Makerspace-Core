import type { PdfTemplateSchema } from '../../api/generated/models';
import type { Block, Layer, TemplateDocument } from './model';

/** A small document that touches every container kind: layers, header, body (if/columns/repeat) and footer. */
export function sampleDocument(): TemplateDocument {
  const title: Block = { id: 'title', type: 'heading', text: 'Invoice request {{request.number}}', size: 17 };
  const intro: Block = { id: 'intro', type: 'text', text: 'Hello' };
  const note: Block = { id: 'note', type: 'text', text: 'Note' };
  const price: Block = { id: 'price', type: 'text', text: 'Price' };
  const list: Block = { id: 'rep', type: 'repeat', source: 'items', as: 'item', blocks: [price] };
  const cond: Block = { id: 'cond', type: 'if', when: { path: 'request.note', op: 'exists' }, then: [note], else: [] };
  const cols: Block = {
    id: 'cols',
    type: 'columns',
    gap: 3,
    columns: [
      { width: 1, blocks: [] },
      { width: 1, blocks: [] },
    ],
  };
  const stamp: Block = { id: 'stamp', type: 'rect', x: 20, y: 30, w: 40, h: 10, stroke: 0.3, color: '#161616' };
  const layer: Layer = { id: 'layer1', type: 'layer', title: 'Stamps', pages: 'all', elements: [stamp] };
  return {
    schemaVersion: 1,
    name: 'Test template',
    export: 'wiref',
    page: {
      size: 'A4',
      orientation: 'portrait',
      margins: [30, 20, 22, 20],
      font: 'IBM Plex Sans',
      baseSize: 10,
      accent: '#0f62fe',
      locale: 'en',
      accentBar: true,
      filename: 'invoice-{{request.number}}.pdf',
    },
    styles: {
      colors: [{ id: 'text', name: 'Text', value: '#161616' }],
      text: [
        { id: 'body', name: 'Body', font: 'IBM Plex Sans', size: 10, weight: 400, lineHeight: 1.4, color: '$c:text' },
      ],
      sizes: [],
    },
    layers: [layer],
    header: [{ id: 'logo', type: 'image', height: 12 }],
    body: [title, intro, cond, list, cols],
    footer: [{ id: 'pageno', type: 'text', text: 'Page {{page}} / {{pages}}', size: 8 }],
  };
}

export function sampleSchema(): PdfTemplateSchema {
  return {
    groups: [
      {
        name: 'Request',
        fields: [
          { path: 'request.number', type: 'text', description: 'Request number', example: 'IR-2026-0042' },
          { path: 'request.total', type: 'money', description: 'Total', example: '120.00' },
        ],
      },
      {
        name: 'Items',
        list: 'items',
        fields: [
          { path: 'items[].description', type: 'text', description: 'What was sold' },
          { path: 'items[].amount', type: 'money', description: 'Line amount' },
        ],
      },
    ],
    filters: [{ name: 'currency', description: 'Formats an amount with the currency' }],
  };
}

export const counter = (prefix = 'id') => {
  let n = 0;
  return () => `${prefix}${++n}`;
};
