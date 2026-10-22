// Placeholder escaping shared by announcements (engine/announcements.ts) and the list widgets. Pure and tiny: the player
// loads it statically, while the sanitizer and markdown renderer (richText.ts) are loaded on demand.
// Must match backend/internal/signage/render.go (escapeHTML, escapeMarkdown); the vectors in
// api/testdata/signage-announcement-render.json cover both.

export type RichTextFormat = 'plain' | 'markdown' | 'html';

const HTML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Characters that start inline or block constructs, links and autolinks in markdown; they get a backslash. */
const MARKDOWN_PUNCTUATION = '\\`*_{}[]()#+-.!|~=:';

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]);

/** `&`, `<` and `>` become entities (no raw HTML can appear) and markdown punctuation is backslash-escaped. */
export function escapeMarkdown(value: string): string {
  let out = '';
  for (const char of value) {
    if (char === '&') out += '&amp;';
    else if (char === '<') out += '&lt;';
    else if (char === '>') out += '&gt;';
    else if (MARKDOWN_PUNCTUATION.includes(char)) out += `\\${char}`;
    else out += char;
  }
  return out;
}

/** The escaper for placeholder values inserted into a text of `format` (plain keeps values as typed). */
export function escapeForFormat(format: RichTextFormat | undefined): (value: string) => string {
  if (format === 'html') return escapeHtml;
  if (format === 'markdown') return escapeMarkdown;
  return (value) => value;
}

/**
 * Replaces `{name}` with the (escaped) value; unknown names stay as typed. Only the values are escaped, never the
 * template text.
 */
export function fillPlaceholders(
  template: string,
  values: Readonly<Record<string, string>>,
  format: RichTextFormat | undefined,
): string {
  const escape = escapeForFormat(format);
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? escape(values[key]) : match,
  );
}
