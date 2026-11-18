import { find, type DocumentStyles, type PageSetup, type TemplateDocument } from './model';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Sets properties of a node; a value of `undefined` removes the property (the document is strictly decoded, and an
 * absent property means "default"). Returns the document itself when the node does not exist.
 */
export function setProps(doc: TemplateDocument, id: string, props: Record<string, unknown>): TemplateDocument {
  if (!find(doc, id)) return doc;
  const next = clone(doc);
  const node = find(next, id)!.node as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) delete node[key];
    else node[key] = value;
  }
  return next;
}

export function setPage(doc: TemplateDocument, props: Partial<PageSetup>): TemplateDocument {
  const next = clone(doc);
  const page = next.page as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) delete page[key];
    else page[key] = value;
  }
  return next;
}

export function setName(doc: TemplateDocument, name: string): TemplateDocument {
  return { ...doc, name };
}

/** Properties a text style overrides on a block, by kind of block (strict decoding: only what the block defines). */
export type TextStyleKey = 'size' | 'weight' | 'color' | 'lineHeight';

/**
 * The property changes of switching a block's text style. A style replaces the block's own values; switching back to
 * "Custom" keeps the look by copying the style's values onto the block.
 */
export function textStyleSwitch(
  styles: DocumentStyles,
  currentId: string | undefined,
  nextId: string | undefined,
  keys: readonly TextStyleKey[],
): Record<string, unknown> {
  if (nextId) return { textStyle: nextId, ...Object.fromEntries(keys.map((k) => [k, undefined])) };
  const style = styles.text.find((t) => t.id === currentId);
  return {
    textStyle: undefined,
    ...(style ? Object.fromEntries(keys.map((k) => [k, style[k]])) : {}),
  };
}
