import type { PdfTemplateSchema, PdfTemplateSchemaField } from '../../api/generated/models';
import { walk, type TemplateDocument, type TemplateNode } from './model';

/** Readable names of the schema's field types. */
export const TYPE_NAMES: Record<string, string> = {
  text: 'Text',
  date: 'Date',
  money: 'Amount',
  number: 'Number',
  image: 'Image',
  'list<text>': 'List of texts',
  list: 'List',
};

const LIST_ENTRY = /^(.+)\[\]\.(.+)$/;

const loopOf = (n: TemplateNode): { source: string; as: string } | null =>
  'source' in n && 'as' in n && typeof n.source === 'string' && typeof n.as === 'string' && n.as
    ? { source: n.source, as: n.as }
    : null;

/** The names under which the document's loops over `list` call one entry, in document order. */
export function loopAliases(doc: TemplateDocument, list: string): string[] {
  const aliases: string[] = [];
  walk(doc, ({ node }) => {
    const loop = loopOf(node);
    if (loop?.source === list && !aliases.includes(loop.as)) aliases.push(loop.as);
  });
  return aliases;
}

/**
 * The path to write for a schema path. A field of a list (`items[].amount`) is only reachable inside a loop, by the
 * loop's name: the first loop over that list in the document, else the singular of the list (`item.amount`).
 */
export function insertionPath(doc: TemplateDocument, path: string): string {
  const m = LIST_ENTRY.exec(path);
  if (!m) return path;
  const alias = loopAliases(doc, m[1])[0] ?? (m[1].split('.').pop() ?? m[1]).replace(/s$/, '');
  return `${alias || m[1]}.${m[2]}`;
}

export const variableToken = (path: string): string => `{{${path}}}`;

/** `text` with `token` in place of the selection; `caret` is the position after it. */
export function spliceToken(text: string, start: number, end: number, token: string): { value: string; caret: number } {
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  return { value: text.slice(0, from) + token + text.slice(to), caret: from + token.length };
}

const isScalar = (f: PdfTemplateSchemaField) =>
  !f.path.includes('[]') && f.type !== 'list' && f.type !== 'list<text>' && f.path !== 'page' && f.path !== 'pages';

/** The values a condition or a switch may compare: the export's single values, plus fields of the document's loops. */
export function conditionPaths(doc: TemplateDocument, schema: PdfTemplateSchema): string[] {
  const out: string[] = [];
  const add = (p: string) => out.includes(p) || out.push(p);
  const fields = schema.groups.flatMap((g) => g.fields);
  fields.filter(isScalar).forEach((f) => add(f.path));
  for (const f of fields) {
    const m = LIST_ENTRY.exec(f.path);
    if (m) loopAliases(doc, m[1]).forEach((alias) => add(`${alias}.${m[2]}`));
  }
  return out;
}

/** The loop sources of the export: the lists a table, repeat or list may run over. */
export const listPaths = (schema: PdfTemplateSchema): string[] =>
  schema.groups.flatMap((g) => (g.list ? [g.list] : []));

/** The paths among `redacted` that the node's own expressions use (not those of the blocks inside it). */
export function redactedIn(doc: TemplateDocument, node: TemplateNode, redacted: readonly string[]): string[] {
  if (!redacted.length) return [];
  const own = JSON.stringify(node, (key, value: unknown) =>
    ['blocks', 'then', 'else', 'elements'].includes(key) ? undefined : value,
  );
  return redacted.filter((path) => {
    const m = LIST_ENTRY.exec(path);
    const candidates = m ? loopAliases(doc, m[1]).map((a) => `${a}.${m[2]}`) : [path];
    return candidates.some((c) => own.includes(c));
  });
}

/** The fields and filters that match a search: every word has to occur in the path or the description. */
export function matchesQuery(query: string, ...texts: (string | null | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = texts.join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}
