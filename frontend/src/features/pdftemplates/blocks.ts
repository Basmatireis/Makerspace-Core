import type { PdfTemplateSchema } from '../../api/generated/models';
import type { Block, DocumentStyles, Layer, TemplateNode, ToolType } from './model';

/** A fresh node id (`^[A-Za-z0-9_-]{1,40}$`): short and random, unique in a document with overwhelming probability. */
export function newId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return (
    'n' +
    Array.from(bytes, (b) => b.toString(36).padStart(2, '0'))
      .join('')
      .slice(0, 12)
  );
}

/** What new blocks need to know about the export's data: its lists and a few typical fields. */
export interface SchemaHints {
  /** List paths, e.g. `items`. */
  lists: string[];
  firstText: string;
  firstMoney: string;
  /** The first field of a list, e.g. `description` for `items`. */
  firstField: (list: string) => string;
  /** The first few field names of a list. */
  fieldsOf: (list: string, count: number) => string[];
}

export function schemaHints(schema: PdfTemplateSchema | undefined): SchemaHints {
  const groups = schema?.groups ?? [];
  const fields = groups.flatMap((g) => g.fields);
  const lists = groups.flatMap((g) => (g.list ? [g.list] : []));
  const scalar = (type: string) => fields.find((f) => f.type === type && !f.path.includes('[]'))?.path;
  const fieldsOf = (list: string, count: number) =>
    fields
      .filter((f) => f.path.startsWith(`${list}[].`))
      .slice(0, count)
      .map((f) => f.path.slice(list.length + 3));
  return {
    lists,
    firstText: scalar('text') ?? 'makerspace.name',
    firstMoney: scalar('money') ?? 'page',
    firstField: (list) => fieldsOf(list, 1)[0] ?? 'value',
    fieldsOf,
  };
}

/** The alias of a list's entries: `items` → `item`. */
export const aliasOf = (list: string): string => list.split('.').pop()!.replace(/s$/, '') || 'item';

/** The block a tool inserts, with the defaults of the prototype. Style links are filled in by `fillDefaults`. */
export function makeBlock(
  type: ToolType,
  hints: SchemaHints,
  styles: DocumentStyles,
  id: () => string = newId,
): TemplateNode {
  const node = build(type, hints, id);
  fillDefaults(node, styles);
  return node;
}

function build(type: ToolType, hints: SchemaHints, id: () => string): TemplateNode {
  const list = hints.lists[0] ?? 'items';
  const as = aliasOf(list);
  const entry = `{{${as}.${hints.firstField(list)}}}`;
  const n = id();
  switch (type) {
    case 'heading':
      return { id: n, type, text: 'Heading' };
    case 'text':
      return { id: n, type, text: 'Text with {{makerspace.name}}' };
    case 'ptext':
      return { id: n, type, text: 'Text', size: 9, color: '#161616' };
    case 'pagenum':
      return {
        id: n,
        type: 'text',
        title: 'Page number',
        text: 'Page {{page}} / {{pages}}',
        size: 8,
        color: '#6f6f6f',
      };
    case 'date':
      return { id: n, type: 'text', title: 'Date', text: '{{generatedAt | date}}', size: 9 };
    case 'value':
      return { id: n, type, label: 'Total', value: `{{${hints.firstMoney} | currency}}`, size: 16 };
    case 'list':
      return { id: n, type, source: list, as, text: entry, style: 'bullet' };
    case 'fields':
      return { id: n, type, labelWidth: 48, rows: [{ label: 'Label', value: '' }] };
    case 'table':
      return {
        id: n,
        type,
        source: list,
        as,
        repeatHeader: true,
        headerFill: '#f4f4f4',
        columns: [{ header: 'Entry', value: entry, width: 100, align: 'left' }],
        totals: [],
      };
    case 'sheet': {
      const fields = hints.fieldsOf(list, 4);
      const width = 170 / Math.max(1, fields.length);
      return {
        id: n,
        type,
        source: list,
        as,
        firstTop: 60,
        nextTop: 30,
        rowsFirst: 12,
        rowsNext: 20,
        rowHeight: 9,
        headHeight: 6,
        carryHeight: 8,
        sumHeight: 8,
        fillEmpty: true,
        color: '#3c3c3c',
        columns: fields.map((f, i) => ({
          header: f,
          value: `{{${as}.${f}}}`,
          x: 20 + i * width,
          w: width,
          align: 'left' as const,
        })),
        carry: { label: 'Carried over', value: '' },
        sum: { label: 'Page total', in: '', out: '', balance: '' },
      };
    }
    case 'repeat':
      return { id: n, type, source: list, as, blocks: [{ id: id(), type: 'text', text: entry }] };
    case 'if':
      return { id: n, type, when: { path: '', op: 'exists' }, then: [], else: [] };
    case 'switch':
      return { id: n, type, path: '', cases: [{ value: '', blocks: [] }], else: [] };
    case 'columns':
      return {
        id: n,
        type,
        gap: 6,
        columns: [
          { width: 1, blocks: [] },
          { width: 1, blocks: [] },
        ],
      };
    case 'box':
      return { id: n, type, padding: 4, stroke: 0.3, color: '#c6c6c6', fill: '#f4f4f4', blocks: [] };
    case 'grid':
      return {
        id: n,
        type,
        colWidths: [60, 60],
        stroke: 0.3,
        padding: 1.5,
        rows: [
          { height: 8, cells: [{ text: 'Label' }, { text: 'Value' }] },
          { height: 8, cells: [{ text: 'Label' }, { text: 'Value' }] },
        ],
      };
    case 'image':
      return { id: n, type, height: 12 };
    case 'picture':
      return { id: n, type, asset: '', w: 50, h: 35 };
    case 'graphic':
      return { id: n, type, art: 'htu-letterhead', w: 40, h: 20 };
    case 'qr':
      return { id: n, type, w: 25, h: 25, value: `{{${hints.firstText}}}` };
    case 'barcode':
      return { id: n, type, w: 60, h: 15, value: `{{${hints.firstText}}}`, showText: true };
    case 'signatures':
      return { id: n, type, labels: ['Signature'], height: 18 };
    case 'checkbox':
      return { id: n, type, label: 'Checked', when: { path: '', op: 'exists' } };
    case 'inputline':
      return { id: n, type, label: 'Name' };
    case 'spacer':
      return { id: n, type, height: 4 };
    case 'divider':
      return { id: n, type, stroke: 0.3, color: '#c6c6c6' };
    case 'pagebreak':
      return { id: n, type };
    case 'line':
      return { id: n, type, w: 60, h: 0, stroke: 0.3, color: '#161616' };
    case 'rect':
      return { id: n, type, w: 60, h: 20, stroke: 0.3, color: '#161616' };
    case 'ellipse':
      return { id: n, type, w: 30, h: 30, stroke: 0.3, color: '#161616' };
    case 'layer':
      return { id: n, type, title: 'New layer', pages: 'all', elements: [] } satisfies Layer;
  }
}

const has = (list: readonly { id: string }[], id: string) => list.some((s) => s.id === id);

/**
 * Links a new block to the document's styles: every visible part gets a text, colour or size style unless it has a value
 * of its own, so changing a style reaches everything. Mutates `node` (it is the caller's fresh copy).
 */
export function fillDefaults(node: TemplateNode | TemplateNode[], styles: DocumentStyles): void {
  if (Array.isArray(node)) return node.forEach((n) => fillDefaults(n, styles));
  const colour = (...ids: string[]) => {
    const found = ids.find((i) => has(styles.colors, i));
    return found ? `$c:${found}` : undefined;
  };
  const text = (...ids: string[]) => ids.find((i) => has(styles.text, i));
  const size = (id: string) => (has(styles.sizes, id) ? `$s:${id}` : undefined);
  const x = node as unknown as Record<string, unknown>;
  const set = (key: string, value: unknown) => {
    if (x[key] === undefined && value !== undefined) x[key] = value;
  };
  switch (node.type) {
    case 'text':
      if (node.size == null && !node.textStyle) set('textStyle', text('body'));
      break;
    case 'heading':
      if (node.size == null && !node.textStyle) set('textStyle', text('section'));
      break;
    case 'table':
      set('headerStyle', text('tableHead', 'body'));
      set('bodyStyle', text('body'));
      set('totalsStyle', text('body'));
      set('subStyle', text('small'));
      set('headerRule', colour('text', 'ink'));
      set('rowRule', colour('rule', 'grey'));
      node.headerFill = colour('fill') ?? node.headerFill ?? '#f4f4f4';
      break;
    case 'fields':
      set('labelStyle', text('label', 'body'));
      set('valueStyle', text('body'));
      if (node.boxed) set('ruleColor', colour('ink', 'rule'));
      break;
    case 'list':
    case 'checkbox':
    case 'ptext':
      if (node.size == null && node.color == null && !node.textStyle) set('textStyle', text('body'));
      if (node.type === 'checkbox') set('boxColor', colour('text', 'ink'));
      break;
    case 'signatures':
      set('labelStyle', text('small'));
      set('lineColor', colour('ink', 'text'));
      break;
    case 'inputline':
      set('labelStyle', text('label', 'body'));
      set('lineColor', colour('text', 'ink'));
      break;
    case 'value':
      set('labelStyle', text('small'));
      break;
    case 'divider':
      x.color = colour('rule', 'grey') ?? x.color;
      x.stroke = size('rule') ?? x.stroke;
      break;
    case 'line':
    case 'rect':
    case 'ellipse':
      x.color = colour('text', 'ink') ?? x.color;
      break;
    case 'box':
      x.color = colour('rule', 'grey') ?? x.color;
      x.fill = colour('fill') ?? x.fill;
      break;
    case 'grid':
      x.color = colour('rule', 'grey') ?? x.color;
      break;
    case 'sheet':
      x.color = colour('ink', 'text') ?? x.color;
      set('subColor', colour('grey', 'subtle'));
      break;
    default:
      break;
  }
  for (const key of ['blocks', 'then', 'else', 'elements'] as const) {
    const kids = (node as unknown as Partial<Record<typeof key, Block[]>>)[key];
    if (kids) fillDefaults(kids, styles);
  }
}
