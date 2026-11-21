import type { PdfTemplateDocument } from '../../api/generated/models';
import { styleLabel } from './styles';

/**
 * TypeScript model of the PDF template document (`schemaVersion: 1`, stored as jsonb). The backend validates the
 * document strictly; this model only describes what the editor reads and writes. All helpers here are pure: they never
 * touch a document they are given.
 */

export type ExportKind = 'wiref' | 'cashbook' | 'receipt' | 'projektantrag';

/** `#rrggbb`, a reference to a colour style (`$c:<id>`) or `transparent`. */
export type Color = string;
/** A number (mm or pt, depending on the property) or a reference to a size style (`$s:<id>`). */
export type Length = number | string;
export type TextWeight = 400 | 500 | 600;
export type Align = 'left' | 'center' | 'right';
export type FontName = 'IBM Plex Sans' | 'Helvetica';

export type ConditionOp = 'exists' | 'empty' | 'eq' | 'ne' | 'gt' | 'lt';
export interface Condition {
  path: string;
  op: ConditionOp;
  value?: string;
}

export type PaperSize = 'A3' | 'A4' | 'A5' | 'A6' | 'Letter' | 'Legal' | 'DL' | 'L62' | 'L102' | 'L54' | 'custom';

export interface PageSetup {
  size: PaperSize;
  /** Custom paper only, mm. */
  width?: number;
  height?: number;
  orientation: 'portrait' | 'landscape';
  /** top, right, bottom, left in mm. */
  margins: [number, number, number, number];
  font: FontName;
  /** pt */
  baseSize: number;
  accent: Color;
  locale: 'de' | 'en';
  accentBar: boolean;
  /** Expressions allowed. */
  filename: string;
}

export interface ColorStyle {
  id: string;
  name: string;
  value: string;
}
export interface TextStyle {
  id: string;
  name: string;
  font: FontName;
  /** pt */
  size: Length;
  weight: TextWeight;
  lineHeight: number;
  color: Color;
}
export interface SizeStyle {
  id: string;
  name: string;
  value: number;
  unit: 'mm' | 'pt';
}
export interface DocumentStyles {
  colors: ColorStyle[];
  text: TextStyle[];
  sizes: SizeStyle[];
}

interface NodeBase {
  /** `^[A-Za-z0-9_-]{1,40}$`, unique in the document. */
  id: string;
  /** Editor only, never printed. */
  title?: string;
}
/** Placement in mm. Only blocks inside a page layer carry it (x/y are page coordinates). */
interface Placement {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}
interface BlockBase extends NodeBase, Placement {}

interface TextProps {
  /** Expression, up to 4000 characters. */
  text: string;
  textStyle?: string;
  size?: Length;
  weight?: TextWeight;
  color?: Color;
  align?: Align;
  lineHeight?: number;
}

export interface HeadingBlock extends BlockBase, TextProps {
  type: 'heading';
}
export interface TextBlock extends BlockBase, TextProps {
  type: 'text';
}
/** Free text box; inside a layer it is positioned by x/y/w. */
export interface PTextBlock extends BlockBase, TextProps {
  type: 'ptext';
}
export interface ValueBlock extends BlockBase {
  type: 'value';
  label: string;
  value: string;
  labelStyle?: string;
  textStyle?: string;
  size?: Length;
  weight?: TextWeight;
  color?: Color;
  align?: Align;
}
export interface ListBlock extends BlockBase {
  type: 'list';
  source: string;
  as: string;
  text: string;
  style: 'bullet' | 'number';
  emptyText?: string;
  textStyle?: string;
  size?: Length;
  weight?: TextWeight;
  color?: Color;
  lineHeight?: number;
}
export interface FieldRow {
  label: string;
  value: string;
  bold?: boolean;
  when?: Condition;
}
export interface FieldsBlock extends BlockBase {
  type: 'fields';
  labelWidth: Length;
  boxed?: boolean;
  rows: FieldRow[];
  labelStyle?: string;
  valueStyle?: string;
  fill?: Color;
  ruleColor?: Color;
}
export interface TableColumn {
  header: string;
  value: string;
  sub?: string;
  /** Share of the table width. */
  width: number;
  align: Align;
}
export interface TableTotal {
  label: string;
  value: string;
  bold?: boolean;
  when?: Condition;
}
export interface TableBlock extends BlockBase {
  type: 'table';
  source: string;
  as: string;
  repeatHeader: boolean;
  maxRows?: number;
  maxRowsFirst?: number;
  emptyText?: string;
  columns: TableColumn[];
  totals: TableTotal[];
  headerStyle?: string;
  bodyStyle?: string;
  totalsStyle?: string;
  subStyle?: string;
  headerFill?: Color;
  headerRule?: Color;
  rowRule?: Color;
  zebra?: Color;
}
export interface SheetColumn {
  header: string;
  value: string;
  sub?: string;
  x: number;
  w: number;
  align: Align;
  /** Defaults to `align`. */
  headerAlign?: Align;
}
/** Form table: fixed rows per page at exact positions; the last two columns are the in/out amount columns. */
export interface SheetBlock extends BlockBase {
  type: 'sheet';
  source: string;
  as: string;
  firstTop: number;
  nextTop: number;
  rowsFirst: number;
  rowsNext: number;
  rowHeight: Length;
  headHeight: Length;
  carryHeight: Length;
  sumHeight: Length;
  /** Geometry of the first sheet when it differs from the following ones. */
  rowHeightFirst?: Length;
  headHeightFirst?: Length;
  carryHeightFirst?: Length;
  sumHeightFirst?: Length;
  fillEmpty: boolean;
  color: Color;
  /** Line thickness. */
  stroke?: Length;
  textColor?: Color;
  subColor?: Color;
  headerStyle?: string;
  bodyStyle?: string;
  subStyle?: string;
  totalsStyle?: string;
  columns: SheetColumn[];
  /** `outFill`: the grey cell of the amount-out column. */
  carry: { label: string; value: string; outFill?: Color };
  sum: { label: string; in: string; out: string; balance?: string; outFill?: Color };
}
export interface RepeatBlock extends BlockBase {
  type: 'repeat';
  source: string;
  as: string;
  blocks: Block[];
}
export interface IfBlock extends BlockBase {
  type: 'if';
  when: Condition;
  then: Block[];
  else: Block[];
}
export interface SwitchCase {
  value: string;
  blocks: Block[];
}
export interface SwitchBlock extends BlockBase {
  type: 'switch';
  path: string;
  cases: SwitchCase[];
  else: Block[];
}
export interface ColumnDef {
  /** Share of the width; 0 = content width. */
  width: number;
  blocks: Block[];
}
export interface ColumnsBlock extends BlockBase {
  type: 'columns';
  gap: Length;
  /** 1 to 4 columns. */
  columns: ColumnDef[];
}
export interface BoxBlock extends BlockBase {
  type: 'box';
  padding: Length;
  /** 0 = no stroke. */
  stroke: Length;
  color: Color;
  fill?: Color;
  blocks: Block[];
}
/** The makerspace logo from the branding settings, or the image variable `source` names (such as a signature). */
export interface ImageBlock extends BlockBase {
  type: 'image';
  height: number;
  /** An image variable of the export's data; without it the block draws the logo. */
  source?: string;
}
export interface PictureBlock extends BlockBase {
  type: 'picture';
  /** Asset id. */
  asset: string;
  w: number;
  h: number;
}
export interface GraphicBlock extends BlockBase {
  type: 'graphic';
  /** `htu-letterhead` or `asset:<id>`. */
  art: string;
  w: number;
  h: number;
  color?: Color;
}
export interface QrBlock extends BlockBase {
  type: 'qr';
  value: string;
  w: number;
  h: number;
}
export interface BarcodeBlock extends BlockBase {
  type: 'barcode';
  value: string;
  w: number;
  h: number;
  showText: boolean;
}
export interface SignaturesBlock extends BlockBase {
  type: 'signatures';
  labels: string[];
  height: number;
  labelStyle?: string;
  lineColor?: Color;
}
export interface CheckboxBlock extends BlockBase {
  type: 'checkbox';
  label: string;
  /** The box is ticked when the condition holds. */
  when: Condition;
  boxColor?: Color;
  textStyle?: string;
  size?: Length;
  color?: Color;
}
export interface InputLineBlock extends BlockBase {
  type: 'inputline';
  label: string;
  lineWidth?: number;
  labelStyle?: string;
  lineColor?: Color;
}
export interface SpacerBlock extends BlockBase {
  type: 'spacer';
  height: Length;
}
export interface DividerBlock extends BlockBase {
  type: 'divider';
  stroke: Length;
  color: Color;
}
/** Effective only in the body. */
export interface PageBreakBlock extends BlockBase {
  type: 'pagebreak';
}
/** A line is horizontal when h = 0 and vertical when w = 0. */
export interface LineBlock extends BlockBase {
  type: 'line';
  w: number;
  h: number;
  stroke: Length;
  color: Color;
}
export interface RectBlock extends BlockBase {
  type: 'rect';
  w: number;
  h: number;
  stroke: Length;
  color: Color;
  fill?: Color;
}
export interface EllipseBlock extends BlockBase {
  type: 'ellipse';
  w: number;
  h: number;
  stroke: Length;
  color: Color;
  fill?: Color;
}

export interface GridCell {
  /** Expression. */
  text: string;
  align?: Align;
  valign?: 'top' | 'middle' | 'bottom';
  textStyle?: string;
  size?: Length;
  weight?: TextWeight;
  color?: Color;
  fill?: Color;
  /** Columns the cell spans; the cells of a row together take the grid's columns. */
  span?: number;
}
export interface GridRow {
  /** mm. */
  height: Length;
  cells: GridCell[];
}
/** A table of fixed texts, frames and fills: columns of set widths, rows of set heights (a form head, say). */
export interface GridBlock extends BlockBase {
  type: 'grid';
  /** mm. */
  colWidths: number[];
  stroke?: Length;
  color?: Color;
  padding?: Length;
  rows: GridRow[];
}

export type Block =
  | HeadingBlock
  | TextBlock
  | PTextBlock
  | ValueBlock
  | ListBlock
  | FieldsBlock
  | TableBlock
  | SheetBlock
  | RepeatBlock
  | IfBlock
  | SwitchBlock
  | ColumnsBlock
  | BoxBlock
  | GridBlock
  | ImageBlock
  | PictureBlock
  | GraphicBlock
  | QrBlock
  | BarcodeBlock
  | SignaturesBlock
  | CheckboxBlock
  | InputLineBlock
  | SpacerBlock
  | DividerBlock
  | PageBreakBlock
  | LineBlock
  | RectBlock
  | EllipseBlock;

export type BlockType = Block['type'];
/** Which pages a layer is drawn on. */
export type LayerPages = 'all' | 'first' | 'next' | 'last';
export interface Layer extends NodeBase {
  type: 'layer';
  pages: LayerPages;
  hidden?: boolean;
  elements: Block[];
}
export type TemplateNode = Block | Layer;
export type NodeType = TemplateNode['type'];

export interface TemplateDocument {
  schemaVersion: 1;
  /** 1 to 120 characters. */
  name: string;
  export: ExportKind;
  page: PageSetup;
  styles: DocumentStyles;
  layers: Layer[];
  header: Block[];
  body: Block[];
  footer: Block[];
}

/** The generated client types the document as a free-form object; the server validates it strictly. */
export const documentOf = (raw: PdfTemplateDocument): TemplateDocument => raw as unknown as TemplateDocument;
export const apiDocument = (doc: TemplateDocument): PdfTemplateDocument => doc as unknown as PdfTemplateDocument;

// ---------------------------------------------------------------------------------------------------------------------
// Paper

export const PAPER: Record<Exclude<PaperSize, 'custom'>, { size: [number, number]; label: string }> = {
  A3: { size: [297, 420], label: 'A3' },
  A4: { size: [210, 297], label: 'A4' },
  A5: { size: [148, 210], label: 'A5' },
  A6: { size: [105, 148], label: 'A6' },
  Letter: { size: [215.9, 279.4], label: 'US Letter' },
  Legal: { size: [215.9, 355.6], label: 'US Legal' },
  DL: { size: [99, 210], label: 'DL (⅓ A4)' },
  L62: { size: [62, 100], label: 'Label 62 × 100 mm' },
  L102: { size: [102, 152], label: 'Label 102 × 152 mm' },
  L54: { size: [54, 85.6], label: 'Card 54 × 85.6 mm' },
};

/** Width and height of one page in mm, after orientation: portrait has the shorter side across. */
export function pageSize(page: Pick<PageSetup, 'size' | 'width' | 'height' | 'orientation'>): [number, number] {
  const base: [number, number] =
    page.size === 'custom'
      ? [Number(page.width) || 210, Number(page.height) || 297]
      : (PAPER[page.size] ?? PAPER.A4).size;
  const short = Math.min(base[0], base[1]);
  const long = Math.max(base[0], base[1]);
  return page.orientation === 'landscape' ? [long, short] : [short, long];
}

export function paperLabel(page: PageSetup): string {
  const [w, h] = pageSize(page);
  const name = page.size === 'custom' ? 'Custom' : (PAPER[page.size] ?? PAPER.A4).label;
  return `${name} ${page.orientation} · ${+w.toFixed(1)} × ${+h.toFixed(1)} mm`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Labels

/** Type names as the editor shows them. */
export const TYPE_LABELS = {
  heading: 'Heading',
  text: 'Text',
  ptext: 'Free text',
  value: 'Value with label',
  list: 'Bullet list (loop)',
  fields: 'Label & value list',
  table: 'Table (loop)',
  sheet: 'Form table (loop)',
  repeat: 'Repeat (loop)',
  if: 'Condition',
  switch: 'Switch',
  columns: 'Columns',
  box: 'Box',
  grid: 'Grid (fixed table)',
  image: 'Logo',
  picture: 'Image',
  graphic: 'Graphic',
  qr: 'QR code',
  barcode: 'Barcode',
  signatures: 'Signature fields',
  checkbox: 'Checkbox',
  inputline: 'Fill-in line',
  spacer: 'Space',
  divider: 'Divider',
  pagebreak: 'Page break',
  line: 'Line',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  layer: 'Page layer',
  pagenum: 'Page number',
  date: 'Date',
} as const satisfies Record<NodeType | 'pagenum' | 'date', string>;

/** What a tool inserts: every node type, plus two presets of the text block. */
export type ToolType = keyof typeof TYPE_LABELS;

export const PAGE_LABELS: Record<LayerPages, string> = {
  all: 'Every page',
  first: 'First page',
  next: 'Following pages',
  last: 'Last page',
};
export const OP_LABELS: Record<ConditionOp, string> = {
  exists: 'is set',
  empty: 'is empty',
  eq: 'equals',
  ne: 'differs from',
  gt: '>',
  lt: '<',
};

/** Blocks that sit at a position of their own inside a page layer. */
export const POSITIONED: readonly BlockType[] = [
  'ptext',
  'line',
  'rect',
  'graphic',
  'ellipse',
  'picture',
  'qr',
  'barcode',
];
/** Blocks with a width and a height of their own (all eight resize handles). */
export const SIZED: readonly BlockType[] = ['rect', 'graphic', 'ellipse', 'picture', 'qr', 'barcode'];

// ---------------------------------------------------------------------------------------------------------------------
// Containers: every place a node can sit

export type Root = 'layers' | 'header' | 'body' | 'footer';
/** The areas of the structure: the four roots plus the elements inside a layer. */
export type Area = Root | 'layer';
export type Slot = 'then' | 'else' | 'blocks' | 'elements' | `column:${number}` | `case:${number}`;
/** The address of one list of nodes: a root of the document, or a child list of a node. Survives copies of the document. */
export type Container = { root: Root } | { node: string; slot: Slot };

export const containerKey = (c: Container): string => ('root' in c ? `root:${c.root}` : `${c.node}/${c.slot}`);
export const sameContainer = (a: Container, b: Container): boolean => containerKey(a) === containerKey(b);
export const ROOTS: readonly Root[] = ['layers', 'header', 'body', 'footer'];

/** A child list of a node, or undefined when the node has no such list. */
export function slotArray(node: TemplateNode, slot: Slot): TemplateNode[] | undefined {
  switch (node.type) {
    case 'if':
      return slot === 'then' ? node.then : slot === 'else' ? node.else : undefined;
    case 'switch': {
      if (slot === 'else') return node.else;
      const m = /^case:(\d+)$/.exec(slot);
      return m ? node.cases[Number(m[1])]?.blocks : undefined;
    }
    case 'repeat':
    case 'box':
      return slot === 'blocks' ? node.blocks : undefined;
    case 'layer':
      return slot === 'elements' ? node.elements : undefined;
    case 'columns': {
      const m = /^column:(\d+)$/.exec(slot);
      return m ? node.columns[Number(m[1])]?.blocks : undefined;
    }
    default:
      return undefined;
  }
}

/** The child lists of a node in display order, with the label the structure shows above each. */
export function slotsOf(node: TemplateNode): { slot: Slot; label: string }[] {
  switch (node.type) {
    case 'if':
      return [
        { slot: 'then', label: 'Then' },
        { slot: 'else', label: 'Else' },
      ];
    case 'switch':
      return [
        ...node.cases.map((c, i) => ({ slot: `case:${i}` as Slot, label: `When “${c.value}”` })),
        { slot: 'else', label: 'Otherwise' },
      ];
    case 'repeat':
    case 'box':
      return [{ slot: 'blocks', label: '' }];
    case 'layer':
      return [{ slot: 'elements', label: '' }];
    case 'columns':
      return node.columns.map((_, i) => ({ slot: `column:${i}` as Slot, label: `Column ${i + 1}` }));
    default:
      return [];
  }
}

/** Where a click on a container row puts a new block: the first child list. */
export function innerOf(node: TemplateNode): Slot | null {
  switch (node.type) {
    case 'if':
      return 'then';
    case 'repeat':
    case 'box':
      return 'blocks';
    case 'columns':
      return 'column:0';
    case 'switch':
      return node.cases.length ? 'case:0' : 'else';
    case 'layer':
      return 'elements';
    default:
      return null;
  }
}

export function getContainer(doc: TemplateDocument, c: Container): TemplateNode[] | undefined {
  if ('root' in c) return doc[c.root];
  const owner = find(doc, c.node);
  return owner ? slotArray(owner.node, c.slot) : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Traversal

export interface Visit {
  node: TemplateNode;
  container: Container;
  index: number;
  area: Area;
  parent: TemplateNode | null;
  depth: number;
  /** The page layer the node sits in (or is), if any. */
  layer: Layer | null;
}

export function walk(doc: TemplateDocument, fn: (visit: Visit) => void): void {
  const visit = (
    list: readonly TemplateNode[],
    container: Container,
    area: Area,
    parent: TemplateNode | null,
    depth: number,
    layer: Layer | null,
  ) => {
    list.forEach((node, index) => {
      const own = node.type === 'layer' ? node : layer;
      fn({ node, container, index, area, parent, depth, layer: own });
      for (const { slot } of slotsOf(node)) {
        const kids = slotArray(node, slot);
        if (kids) visit(kids, { node: node.id, slot }, node.type === 'layer' ? 'layer' : area, node, depth + 1, own);
      }
    });
  };
  for (const root of ROOTS) visit(doc[root], { root }, root, null, 0, null);
}

export function find(doc: TemplateDocument, id: string): Visit | null {
  let found: Visit | null = null;
  walk(doc, (v) => {
    if (!found && v.node.id === id) found = v;
  });
  return found;
}

export function allIds(doc: TemplateDocument): Set<string> {
  const ids = new Set<string>();
  walk(doc, (v) => ids.add(v.node.id));
  return ids;
}

export function countNodes(doc: TemplateDocument): number {
  let n = 0;
  walk(doc, () => (n += 1));
  return n;
}

/** The ids of a node and everything inside it. */
export function subtreeIds(node: TemplateNode): Set<string> {
  const ids = new Set<string>();
  const visit = (n: TemplateNode) => {
    ids.add(n.id);
    for (const { slot } of slotsOf(n)) slotArray(n, slot)?.forEach(visit);
  };
  visit(node);
  return ids;
}

/** True when `dest` is a child list of the node itself or of anything inside it (a node cannot move into itself). */
export function isInside(node: TemplateNode, dest: Container): boolean {
  return 'node' in dest && subtreeIds(node).has(dest.node);
}

/** The layer a container belongs to: the layer's own element list or any list nested in one of its elements. */
export function layerOfContainer(doc: TemplateDocument, c: Container): Layer | null {
  if ('root' in c) return null;
  const owner = find(doc, c.node);
  return owner?.layer ?? null;
}

/**
 * Whether a node (or a new block of a type) may be dropped into a container. Layers only live among the layers, or are
 * merged into another layer's element list; blocks may go anywhere, a block dropped among the layers gets a layer.
 */
export function canDrop(doc: TemplateDocument, subject: { id?: string; type: ToolType }, dest: Container): boolean {
  if (!getContainer(doc, dest)) return false;
  const moving = subject.id ? find(doc, subject.id) : null;
  if (moving && isInside(moving.node, dest)) return false;
  if (subject.type !== 'layer') return true;
  if ('root' in dest) return dest.root === 'layers';
  const host = find(doc, dest.node);
  return dest.slot === 'elements' && host?.node.type === 'layer' && host.node.id !== subject.id;
}

// ---------------------------------------------------------------------------------------------------------------------
// Titles and descriptions

const loopSource = (n: TemplateNode) => ('source' in n ? n.source : '');

export function defaultTitle(n: TemplateNode): string {
  if (n.type === 'table' || n.type === 'repeat' || n.type === 'sheet')
    return `${TYPE_LABELS[n.type].replace(' (loop)', '')}: ${loopSource(n)}`;
  if (n.type === 'columns') return `${n.columns.length} columns`;
  return TYPE_LABELS[n.type];
}

export const titleOf = (n: TemplateNode): string => n.title || defaultTitle(n);

export interface Description {
  /** The first line: the block's own title. */
  l1: string;
  /** The second line: what kind of block it is, never its content. */
  l2?: string;
  strong?: boolean;
  untitled?: boolean;
  /** Spacers, dividers and page breaks take one slim line. */
  compact?: boolean;
}

function conditionText(c: Condition | undefined): string {
  if (!c) return '';
  const op = OP_LABELS[c.op] ?? '';
  return `${c.path || '…'} ${op}${c.op === 'exists' || c.op === 'empty' ? '' : ' ' + (c.value ?? '')}`;
}

export function describe(n: TemplateNode, styles?: DocumentStyles): Description {
  const type = TYPE_LABELS[n.type];
  const pos = n.type !== 'layer' && n.x != null ? ` · x ${n.x} y ${n.y} mm` : '';
  if (n.type === 'spacer') return { l1: n.title || `Space · ${styleLabel(n.height, styles)}`, compact: true };
  if (n.type === 'divider' || n.type === 'pagebreak') return { l1: n.title || type, compact: true };
  let kind: string;
  switch (n.type) {
    case 'heading':
      return {
        l1: titleOf(n),
        strong: true,
        untitled: !n.title,
        l2: `Heading${n.size != null ? ` · ${styleLabel(n.size, styles, 'pt')}` : ''}${pos}`,
      };
    case 'fields':
      kind = `Label & value list · ${n.rows.length} rows`;
      break;
    case 'table':
      kind = `Table · each ${n.as} in ${n.source} · ${n.columns.length} columns`;
      break;
    case 'sheet':
      kind = `Form table · each ${n.as} in ${n.source} · ${n.rowsFirst}/${n.rowsNext} rows`;
      break;
    case 'repeat':
      kind = `Repeat · each ${n.as} in ${n.source}`;
      break;
    case 'if':
      kind = `Condition · if ${conditionText(n.when)}`;
      break;
    case 'columns':
      kind = 'Columns';
      break;
    case 'image':
      kind = n.source
        ? `Image · ${n.source} · ${styleLabel(n.height, styles)} high`
        : `Logo · ${styleLabel(n.height, styles)} high`;
      break;
    case 'signatures':
      kind = `Signature fields · ${n.labels.length}`;
      break;
    case 'list':
      kind = `Bullet list · each ${n.as} in ${n.source}`;
      break;
    case 'switch':
      kind = `Switch on ${n.path || '…'} · ${n.cases.length} cases`;
      break;
    case 'box':
      kind = `Box · ${n.blocks.length} blocks`;
      break;
    case 'grid':
      kind = `Grid · ${n.rows.length} rows × ${n.colWidths.length} columns`;
      break;
    case 'layer':
      kind = `Page layer · ${PAGE_LABELS[n.pages]} · ${n.elements.length} elements${n.hidden ? ' · hidden' : ''}`;
      break;
    default:
      kind = type;
  }
  return {
    l1: titleOf(n),
    strong: ['if', 'switch', 'layer', 'sheet'].includes(n.type),
    untitled: !n.title,
    l2: kind + pos,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Places

export interface Place {
  label: string;
  container: Container;
}

/**
 * Every place a node can go, for a "Move to" list. With `excludeId`, places inside that node are left out; a layer can
 * only go among the layers.
 */
export function places(doc: TemplateDocument, excludeId?: string): Place[] {
  const moving = excludeId ? find(doc, excludeId)?.node : undefined;
  if (moving?.type === 'layer') return [{ label: 'Page layers', container: { root: 'layers' } }];
  const skip = moving ? subtreeIds(moving) : new Set<string>();
  const out: Place[] = [];
  const rec = (list: readonly TemplateNode[], label: string) => {
    for (const n of list) {
      if (skip.has(n.id)) continue;
      for (const { slot, label: slotLabel } of slotsOf(n)) {
        const where = `${label} › ${titleOf(n)}${slotLabel ? ` › ${slotLabel}` : ''}`;
        if (n.type !== 'layer') out.push({ label: where, container: { node: n.id, slot } });
        rec(slotArray(n, slot) ?? [], where);
      }
    }
  };
  for (const layer of doc.layers) {
    out.push({ label: `Layer “${titleOf(layer)}”`, container: { node: layer.id, slot: 'elements' } });
    rec(layer.elements, `Layer “${titleOf(layer)}”`);
  }
  out.push({ label: 'New page layer', container: { root: 'layers' } });
  for (const [root, label] of [
    ['header', 'Header'],
    ['body', 'Body'],
    ['footer', 'Footer'],
  ] as const) {
    out.push({ label, container: { root } });
    rec(doc[root], label);
  }
  return out;
}

/**
 * The page-layer element a node belongs to: the node itself when it sits directly in a layer, else its nearest ancestor
 * that does. Null for nodes outside layers (and for layers). Clicking something inside a layer element selects the element.
 */
export function layerElementId(doc: TemplateDocument, id: string): string | null {
  let at = find(doc, id);
  while (at) {
    if (at.node.type === 'layer') return null;
    if (at.parent?.type === 'layer') return at.node.id;
    at = at.parent ? find(doc, at.parent.id) : null;
  }
  return null;
}
