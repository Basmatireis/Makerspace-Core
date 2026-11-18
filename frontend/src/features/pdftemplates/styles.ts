import type { ColorStyle, DocumentStyles, FontName, SizeStyle, TemplateDocument, TextStyle, TextWeight } from './model';

/**
 * Document styles (colours, text styles, sizes) like design-tool variables: a property holds a reference (`$c:<id>`,
 * `$s:<id>`, a text style id) and follows the style. These helpers are pure; edits return a new document.
 */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const colorToken = (id: string): string => `$c:${id}`;
export const sizeToken = (id: string): string => `$s:${id}`;

/** Properties that hold the id of a text style. */
const TEXT_STYLE_KEYS: ReadonlySet<string> = new Set([
  'textStyle',
  'labelStyle',
  'valueStyle',
  'headerStyle',
  'bodyStyle',
  'totalsStyle',
  'subStyle',
]);
/** What `textStyle` overrides on a block; copied onto the block when the style is dropped. */
const TEXT_STYLE_VALUES = ['size', 'weight', 'color', 'lineHeight'] as const;

export const colorRef = (value: unknown, styles: DocumentStyles): ColorStyle | undefined =>
  typeof value === 'string' && value.startsWith('$c:') ? styles.colors.find((c) => c.id === value.slice(3)) : undefined;

export const sizeRef = (value: unknown, styles: DocumentStyles): SizeStyle | undefined =>
  typeof value === 'string' && value.startsWith('$s:') ? styles.sizes.find((s) => s.id === value.slice(3)) : undefined;

/** The `#rrggbb` a colour value shows: '' for none/transparent, magenta for a reference to a style that is gone. */
export function resolveColor(value: unknown, styles: DocumentStyles): string {
  if (typeof value !== 'string' || value === 'transparent' || value === '') return '';
  if (value.startsWith('$c:')) return colorRef(value, styles)?.value ?? '#ff00ff';
  return value;
}

/** The number a length shows: a size style's value, or the number itself. */
export function resolveLength(value: unknown, styles: DocumentStyles): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.startsWith('$s:')) return sizeRef(value, styles)?.value ?? 0;
  return Number(value) || 0;
}

const countIn = (x: unknown, test: (key: string, value: unknown) => boolean, key = ''): number => {
  if (Array.isArray(x)) return x.reduce<number>((n, y) => n + countIn(y, test, key), 0);
  if (x && typeof x === 'object') return Object.entries(x).reduce((n, [k, v]) => n + countIn(v, test, k), 0);
  return test(key, x) ? 1 : 0;
};

/** The document without the colour and size lists themselves: only places that use a style. Text styles do use others. */
const consumers = (doc: TemplateDocument) => ({ ...doc, styles: { text: doc.styles.text } });

/** How often a colour (`$c:<id>`) or size (`$s:<id>`) is used by the page, blocks and text styles. */
export const countUsage = (doc: TemplateDocument, token: string): number =>
  countIn(consumers(doc), (_key, value) => value === token);

/** How many properties of the layers, header, body and footer name a text style. */
export const countTextStyleUsage = (doc: TemplateDocument, id: string): number =>
  countIn([doc.layers, doc.header, doc.body, doc.footer], (k, v) => TEXT_STYLE_KEYS.has(k) && v === id);

/** Replaces every value equal to `match` anywhere in the document (the first step of deleting a style). */
export function detachAll(doc: TemplateDocument, match: string, replacement: string | number): TemplateDocument {
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) {
      x.forEach((y, i) => {
        if (y === match) x[i] = replacement;
        else visit(y);
      });
    } else if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        if (o[k] === match) o[k] = replacement;
        else visit(o[k]);
      }
    }
  };
  const next = clone(doc);
  visit(next);
  return next;
}

/** A style id (`^[A-Za-z0-9_-]{1,40}$`) that no style of the document uses yet. */
export function newStyleId(prefix: 'c' | 't' | 's', styles: DocumentStyles): string {
  const taken = new Set([...styles.colors, ...styles.text, ...styles.sizes].map((s) => s.id));
  for (;;) {
    const id = prefix + Math.random().toString(36).slice(2, 8);
    if (!taken.has(id)) return id;
  }
}

export function addColor(doc: TemplateDocument, value: string, name?: string): { doc: TemplateDocument; id: string } {
  const next = clone(doc);
  const id = newStyleId('c', next.styles);
  next.styles.colors.push({ id, name: name ?? `Colour ${next.styles.colors.length + 1}`, value });
  return { doc: next, id };
}

export function addTextStyle(doc: TemplateDocument): { doc: TemplateDocument; id: string } {
  const next = clone(doc);
  const id = newStyleId('t', next.styles);
  const first = next.styles.colors[0];
  next.styles.text.push({
    id,
    name: `Text style ${next.styles.text.length + 1}`,
    font: 'IBM Plex Sans',
    size: 10,
    weight: 400,
    lineHeight: 1.4,
    color: first ? colorToken(first.id) : '#161616',
  });
  return { doc: next, id };
}

export function addSize(doc: TemplateDocument): { doc: TemplateDocument; id: string } {
  const next = clone(doc);
  const id = newStyleId('s', next.styles);
  next.styles.sizes.push({ id, name: `Size ${next.styles.sizes.length + 1}`, value: 5, unit: 'mm' });
  return { doc: next, id };
}

type StylePatch<T> = Partial<Omit<T, 'id'>>;

export function updateColor(doc: TemplateDocument, id: string, patch: StylePatch<ColorStyle>): TemplateDocument {
  const next = clone(doc);
  const style = next.styles.colors.find((c) => c.id === id);
  if (style) Object.assign(style, patch);
  return next;
}

export function updateTextStyle(
  doc: TemplateDocument,
  id: string,
  patch: StylePatch<TextStyle> & { font?: FontName; weight?: TextWeight },
): TemplateDocument {
  const next = clone(doc);
  const style = next.styles.text.find((t) => t.id === id);
  if (style) Object.assign(style, patch);
  return next;
}

export function updateSize(doc: TemplateDocument, id: string, patch: StylePatch<SizeStyle>): TemplateDocument {
  const next = clone(doc);
  const style = next.styles.sizes.find((s) => s.id === id);
  if (style) Object.assign(style, patch);
  return next;
}

/** Deletes a colour; every use keeps the colour it showed. */
export function removeColor(doc: TemplateDocument, id: string): TemplateDocument {
  const value = doc.styles.colors.find((c) => c.id === id)?.value;
  if (value === undefined) return doc;
  const next = detachAll(doc, colorToken(id), value);
  next.styles.colors = next.styles.colors.filter((c) => c.id !== id);
  return next;
}

/** Deletes a size; every use keeps the number it showed. */
export function removeSize(doc: TemplateDocument, id: string): TemplateDocument {
  const value = doc.styles.sizes.find((s) => s.id === id)?.value;
  if (value === undefined) return doc;
  const next = detachAll(doc, sizeToken(id), value);
  next.styles.sizes = next.styles.sizes.filter((s) => s.id !== id);
  return next;
}

/**
 * Deletes a text style. A block that used it as its `textStyle` keeps the values; the parts of tables, lists and forms
 * that name a style (header text, label text …) have no values of their own and fall back to their default.
 */
export function removeTextStyle(doc: TemplateDocument, id: string): TemplateDocument {
  const style = doc.styles.text.find((t) => t.id === id);
  if (!style) return doc;
  const next = clone(doc);
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(visit);
    if (!x || typeof x !== 'object') return;
    const o = x as Record<string, unknown>;
    for (const key of Object.keys(o)) {
      if (TEXT_STYLE_KEYS.has(key) && o[key] === id) {
        delete o[key];
        if (key === 'textStyle') for (const v of TEXT_STYLE_VALUES) o[v] = style[v];
      } else visit(o[key]);
    }
  };
  for (const root of ['layers', 'header', 'body', 'footer'] as const) visit(next[root]);
  next.styles.text = next.styles.text.filter((t) => t.id !== id);
  return next;
}
