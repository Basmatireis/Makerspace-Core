import {
  Barcode,
  Box,
  Calendar,
  Checkbox,
  CircleStroke,
  Column,
  ConditionPoint,
  Cursor_1,
  DecisionTree,
  DistributeVerticalCenter,
  Document,
  Grid,
  Image,
  Layers,
  LineThin,
  ListBulleted,
  Loop,
  PageBreak,
  PageNumber,
  Pen,
  QrCode,
  Shapes,
  SquareOutline,
  Subtract,
  Table,
  TableOfContents,
  TableSplit,
  TextFont,
  TextLeading,
  TextLongParagraph,
  TextScale,
  TextUnderline,
} from './icons';
import type { ComponentType } from 'react';
import { TYPE_LABELS, type ToolType } from './model';

export type IconComponent = ComponentType<{ size?: number | string; className?: string }>;

export interface ToolInfo {
  label: string;
  icon: IconComponent;
  description: string;
  /** Keyboard shortcut that picks the tool. */
  key?: string;
}

/** What each tool inserts: icon, one-line explanation and shortcut. Labels come from the model. */
const INFO: Record<ToolType, Omit<ToolInfo, 'label'>> = {
  ptext: { icon: TextFont, description: 'Text box; at an exact position inside a page layer', key: 'T' },
  heading: { icon: TextScale, description: 'Large text line with variables', key: 'H' },
  text: { icon: TextLongParagraph, description: 'Paragraph with variables, wraps across lines' },
  value: { icon: TextLeading, description: 'One value, e.g. a total, with a small label' },
  list: { icon: ListBulleted, description: 'One bullet or number per entry of a list' },
  pagenum: { icon: PageNumber, description: '“Page 2 / 5”' },
  date: { icon: Calendar, description: 'Date the PDF is created' },
  table: { icon: Table, description: 'One row per entry of a list, repeats its header on new pages' },
  fields: { icon: TableOfContents, description: 'Rows like “Recipient: …”, each row optional' },
  sheet: { icon: TableSplit, description: 'Fixed rows per page at exact positions, carried balance and sums' },
  repeat: { icon: Loop, description: 'Repeat any blocks for every entry of a list' },
  if: { icon: ConditionPoint, description: 'Show blocks only when a value is set or matches' },
  switch: { icon: DecisionTree, description: 'Different blocks per value, e.g. per payment method' },
  box: { icon: Box, description: 'Frame or background around blocks; stays on one page' },
  grid: { icon: Grid, description: 'Rows and columns with fixed texts, frames and fills, e.g. a form head' },
  columns: { icon: Column, description: 'Place blocks side by side' },
  spacer: { icon: DistributeVerticalCenter, description: 'Vertical gap in millimetres' },
  divider: { icon: Subtract, description: 'Horizontal rule' },
  pagebreak: { icon: PageBreak, description: 'Continue on a new page' },
  rect: { icon: SquareOutline, description: 'Frame or filled box', key: 'R' },
  ellipse: { icon: CircleStroke, description: 'Circle or oval', key: 'O' },
  line: { icon: LineThin, description: 'Straight rule, e.g. a form line or fold mark', key: 'L' },
  picture: { icon: Image, description: 'Uploaded PNG or JPEG', key: 'I' },
  image: { icon: Image, description: 'Makerspace logo from the branding settings' },
  graphic: { icon: Shapes, description: 'Vector artwork uploaded as SVG' },
  qr: { icon: QrCode, description: 'Encodes a value, e.g. the order number' },
  barcode: { icon: Barcode, description: 'Code 128 of a value' },
  signatures: { icon: Pen, description: 'Lines to sign on paper' },
  checkbox: { icon: Checkbox, description: 'Empty or ticked box, ticked by a condition' },
  inputline: { icon: TextUnderline, description: 'Label with a blank line to write on' },
  layer: { icon: Layers, description: 'Fixed-position elements on chosen pages' },
};

export const toolInfo = (type: ToolType): ToolInfo => ({ label: TYPE_LABELS[type], ...INFO[type] });
export const SELECT_ICON: IconComponent = Cursor_1;
export const PAGE_ICON: IconComponent = Document;

export interface ToolGroup {
  key: string;
  label: string;
  items: ToolType[];
}

/** The groups of the insert toolbar: the first item is what the group button shows until another one was used. */
export const TOOL_GROUPS: readonly ToolGroup[] = [
  { key: 'text', label: 'Text', items: ['ptext', 'heading', 'text', 'value', 'list', 'pagenum', 'date'] },
  { key: 'data', label: 'Data and loops', items: ['table', 'fields', 'sheet', 'repeat'] },
  { key: 'logic', label: 'Conditions', items: ['if', 'switch'] },
  { key: 'layout', label: 'Layout', items: ['box', 'grid', 'columns', 'spacer', 'divider', 'pagebreak'] },
  { key: 'shapes', label: 'Shapes', items: ['rect', 'ellipse', 'line'] },
  { key: 'media', label: 'Images and codes', items: ['picture', 'image', 'graphic', 'qr', 'barcode'] },
  { key: 'form', label: 'Form fields', items: ['signatures', 'checkbox', 'inputline'] },
];

export const toolForKey = (key: string): ToolType | undefined =>
  (Object.keys(INFO) as ToolType[]).find((type) => INFO[type].key === key.toUpperCase());

/** Icon colouring in the structure: loops, conditions and page-layer elements stand out. */
export type IconTone = 'loop' | 'cond' | 'pos' | 'layer' | undefined;
export const iconTone = (type: ToolType | string): IconTone => {
  if (type === 'table' || type === 'repeat' || type === 'sheet' || type === 'list') return 'loop';
  if (type === 'if' || type === 'switch') return 'cond';
  if (type === 'layer') return 'layer';
  return ['ptext', 'line', 'rect', 'graphic', 'ellipse', 'picture', 'qr', 'barcode'].includes(type) ? 'pos' : undefined;
};
