import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { escapeHtml, type RichTextFormat } from './escape';

// Rich text for signage widgets: markdown (marked, GFM) and HTML are sanitized by the browser (DOMPurify plus the CSS
// sanitizer below); the backend never renders HTML. Pure functions without React so admin previews and the player share
// them. The module is large (about 20 kB gzip), so RichText.tsx loads it with a dynamic import. CSP (`script-src 'self'`)
// stays the second line of defence. The result is placed in a shadow root (RichText.tsx), which scopes the CSS.

export { escapeForFormat, escapeHtml, escapeMarkdown, fillPlaceholders, type RichTextFormat } from './escape';

// ---------------------------------------------------------------------------------------------------------------------
// URLs: https:, data:image/, relative references and fragments. Everything else (javascript:, http:, vbscript:, ...) goes.

/** Strips control characters and whitespace the URL parser ignores, so "java\tscript:" cannot hide a scheme. */
const normalizeUrl = (value: string) =>
  // eslint-disable-next-line no-control-regex -- the point is to remove them
  value.replace(/[\u0000-\u0020\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\ufeff]/g, '');

export function isAllowedUrl(value: string): boolean {
  const url = normalizeUrl(value).toLowerCase();
  if (url === '') return true;
  if (url.startsWith('https:') || url.startsWith('data:image/') || url.startsWith('#')) return true;
  // Anything with another scheme is out; no scheme means a relative reference.
  return !/^[a-z][a-z0-9+.-]*:/.test(url);
}

// ---------------------------------------------------------------------------------------------------------------------
// CSS sanitizer. Works on tokens it needs to recognise (strings, comments, identifiers with escapes, url(), at-rules), so
// escape tricks like `u\72l(` or `@\69mport` cannot slip past. Output is normalised: comments become a space, escaped
// identifier characters are decoded, `url()` is rebuilt from its decoded value.

const IDENT_START = /[A-Za-z_\u0080-\uffff-]/;
const IDENT_CHAR = /[A-Za-z0-9_\u0080-\uffff-]/;
const BLOCKED_AT_RULES = new Set(['import', 'font-face', 'namespace', 'charset']);
/** Functions that load resources outside the url() allow-list or run code. They are replaced by `none`. */
const BLOCKED_FUNCTIONS = new Set(['expression', 'image-set', '-webkit-image-set', 'src', 'cross-fade', 'element']);
/** Legacy script hooks: the property name is renamed so the declaration becomes invalid. */
const BLOCKED_IDENTS = new Set(['behavior', '-moz-binding']);

/** Reads one CSS escape starting at the backslash; returns the decoded text and the index after it. */
function readEscape(text: string, start: number): { value: string | null; end: number } {
  const hex = /^[0-9a-fA-F]{1,6}/.exec(text.slice(start + 1, start + 7));
  if (hex) {
    let end = start + 1 + hex[0].length;
    if (/\s/.test(text[end] ?? '')) end += text[end] === '\r' && text[end + 1] === '\n' ? 2 : 1;
    const code = parseInt(hex[0], 16);
    const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return { value: valid ? String.fromCodePoint(code) : '\ufffd', end };
  }
  const next = text[start + 1];
  if (next === undefined) return { value: null, end: start + 1 };
  if (next === '\n' || next === '\r' || next === '\f') return { value: null, end: start + 2 };
  return { value: next, end: start + 2 };
}

/** Index after the string that starts at `start` (a quote); an unterminated string runs to the end. */
function stringEnd(text: string, start: number): number {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') index += 2;
    else if (char === quote) return index + 1;
    else if (char === '\n') return index;
    else index += 1;
  }
  return text.length;
}

/** The value of a CSS string token (without quotes), with escapes decoded. */
function stringValue(token: string): string {
  const body = token.slice(1, token.endsWith(token[0]) && token.length > 1 ? -1 : undefined);
  let out = '';
  for (let index = 0; index < body.length;) {
    if (body[index] === '\\') {
      const escape = readEscape(body, index);
      out += escape.value ?? '';
      index = escape.end;
    } else {
      out += body[index];
      index += 1;
    }
  }
  return out;
}

/** Index after the balanced `(...)` group whose opening parenthesis is at `open`. */
function groupEnd(text: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'") index = stringEnd(text, index);
    else if (char === '\\') index += 2;
    else {
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
  }
  return text.length;
}

/** Index after the at-rule that starts at `start`: up to the next top-level `;` or through its `{...}` block. */
function atRuleEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'") index = stringEnd(text, index);
    else if (char === '\\') index += 2;
    else if (char === '(') index = groupEnd(text, index);
    else if (char === ';') return index + 1;
    else if (char === '{') {
      let depth = 0;
      while (index < text.length) {
        const inner = text[index];
        if (inner === '"' || inner === "'") index = stringEnd(text, index);
        else if (inner === '\\') index += 2;
        else {
          if (inner === '{') depth += 1;
          else if (inner === '}') {
            depth -= 1;
            if (depth === 0) return index + 1;
          }
          index += 1;
        }
      }
      return text.length;
    } else index += 1;
  }
  return text.length;
}

/** The identifier at `start` with safe escapes decoded (ASCII letters, digits, `_`, `-`); other escapes stay as written. */
function readIdent(text: string, start: number): { ident: string; end: number } {
  let ident = '';
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      const escape = readEscape(text, index);
      if (escape.value === null) break;
      ident += /^[A-Za-z0-9_-]$/.test(escape.value) ? escape.value : text.slice(index, escape.end);
      index = escape.end;
    } else if (IDENT_CHAR.test(char)) {
      ident += char;
      index += 1;
    } else break;
  }
  return { ident, end: index };
}

/** Reads the argument of `url(` (the `(` is at `open`); returns the decoded value and the index after the `)`. */
function readUrl(text: string, open: number): { value: string; end: number } {
  let index = open + 1;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  if (text[index] === '"' || text[index] === "'") {
    const end = stringEnd(text, index);
    const value = stringValue(text.slice(index, end));
    const close = text.indexOf(')', end);
    return { value, end: close < 0 ? text.length : close + 1 };
  }
  let value = '';
  let depth = 0;
  // A "(" inside an unquoted url is a bad url in CSS; consuming the balanced group keeps stray parentheses out of the output.
  while (index < text.length && (text[index] !== ')' || depth > 0)) {
    if (text[index] === '\\') {
      const escape = readEscape(text, index);
      value += escape.value ?? '';
      index = escape.end;
    } else {
      if (text[index] === '(') depth += 1;
      else if (text[index] === ')') depth -= 1;
      value += text[index];
      index += 1;
    }
  }
  return { value: value.trim(), end: Math.min(text.length, index + 1) };
}

const cssString = (value: string) => `"${value.replace(/[\\"]/g, '\\$&').replace(/[\r\n\f]/g, ' ')}"`;

/**
 * Removes what must not reach the page from author CSS (a `css` field, a `<style>` element or a `style` attribute):
 * `@import`, `@font-face` (fonts come from the scene's font assets), `@namespace`, `expression(`, `behavior:`,
 * `-moz-binding`, `</style` sequences and every `url()` outside the URL allow-list.
 */
export function sanitizeCss(input: string): string {
  const text = input.split('\0').join('');
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
      out += ' ';
    } else if (char === '"' || char === "'") {
      const end = stringEnd(text, index);
      out += text.slice(index, end);
      index = end;
    } else if (char === '@' && (IDENT_START.test(text[index + 1] ?? '') || text[index + 1] === '\\')) {
      const { ident, end } = readIdent(text, index + 1);
      if (BLOCKED_AT_RULES.has(ident.toLowerCase())) index = atRuleEnd(text, end);
      else {
        out += `@${ident}`;
        index = end;
      }
    } else if (IDENT_START.test(char) || char === '\\') {
      const { ident, end } = readIdent(text, index);
      const lower = ident.toLowerCase();
      if (text[end] === '(' && lower === 'url') {
        const url = readUrl(text, end);
        out += isAllowedUrl(url.value) ? `url(${cssString(url.value)})` : 'url("")';
        index = url.end;
      } else if (text[end] === '(' && BLOCKED_FUNCTIONS.has(lower)) {
        out += 'none';
        index = groupEnd(text, end);
      } else if (end === index) {
        // A stray backslash (escaping nothing): keep it as written.
        out += char;
        index += 1;
      } else {
        out += BLOCKED_IDENTS.has(lower) ? 'x-removed' : ident;
        index = end;
      }
    } else {
      out += char;
      index += 1;
    }
  }
  // The result must not be able to close a style element, however the pieces were put together.
  let previous: string;
  do {
    previous = out;
    out = out.replace(/<\/style/gi, '').replace(/expression\s*\(/gi, 'x-removed(');
  } while (out !== previous);
  return out.trim();
}

// ---------------------------------------------------------------------------------------------------------------------
// HTML: DOMPurify, configured once. Style elements survive only in html mode, their text and every style attribute go
// through the CSS sanitizer.

const FORBIDDEN_TAGS = [
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'option',
  'optgroup',
  'textarea',
  'datalist',
  'output',
  'fieldset',
  'link',
  'meta',
  'base',
  'noscript',
  'template',
  'slot',
  'portal',
  'dialog',
];
const FORBIDDEN_ATTRIBUTES = ['formaction', 'srcdoc', 'srcset', 'ping', 'form', 'action', 'autofocus', 'popover'];
const URL_ATTRIBUTES = ['href', 'src', 'poster', 'cite', 'background', 'data', 'longdesc', 'usemap', 'xlink:href'];

let hooked = false;
function installHooks() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style') node.textContent = sanitizeCss(node.textContent ?? '');
  });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const style = element.getAttribute('style');
    if (style !== null) {
      const clean = sanitizeCss(style);
      if (clean === '') element.removeAttribute('style');
      else element.setAttribute('style', clean);
    }
    for (const name of URL_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value !== null && !isAllowedUrl(value)) element.removeAttribute(name);
    }
  });
}

const markdown = new Marked({ gfm: true, async: false });

/**
 * Sanitizes an HTML fragment. `allowStyle` keeps `<style>` elements (html mode only); everything else is identical, so
 * markdown output is held to the same rules.
 */
export function sanitizeHtml(html: string, options: { allowStyle: boolean }): string {
  if (!DOMPurify.isSupported) return escapeHtml(html);
  installHooks();
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_TAGS: options.allowStyle ? ['style'] : [],
    FORBID_TAGS: options.allowStyle ? FORBIDDEN_TAGS : [...FORBIDDEN_TAGS, 'style'],
    FORBID_ATTR: FORBIDDEN_ATTRIBUTES,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: true,
    // A leading <style> would otherwise be dropped with the document head.
    FORCE_BODY: true,
    // https:, data:image/ (see the stricter attribute hook), fragments and relative references.
    ALLOWED_URI_REGEXP: /^(?:https:|data:image\/|#|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
  });
}

export type RichTextInput = { format: RichTextFormat | undefined; text: string; css?: string };
export type RichTextResult = {
  /** Sanitized markup, ready for `innerHTML` of an element inside the zone's shadow root. */
  html: string;
  /** Sanitized author CSS for a `<style>` element in the shadow root. */
  css: string;
};

/**
 * Plain text becomes escaped text, markdown goes through marked (GFM) and DOMPurify, html through DOMPurify with
 * `<style>` allowed. The `css` field is sanitized in every format.
 */
export function renderRichText({ format, text, css = '' }: RichTextInput): RichTextResult {
  const safeCss = sanitizeCss(css);
  if (format === 'markdown') {
    return { html: sanitizeHtml(markdown.parse(text, { async: false }), { allowStyle: false }), css: safeCss };
  }
  if (format === 'html') return { html: sanitizeHtml(text, { allowStyle: true }), css: safeCss };
  return { html: escapeHtml(text), css: safeCss };
}

/** Base look of a rich text document inside its shadow root; author CSS follows and wins. `var(--u)` is inherited. */
export const RICH_TEXT_BASE_CSS = `
:host { display: block; contain: paint; min-inline-size: 0; }
.rt { white-space: normal; font-weight: 400; line-height: 1.3; overflow-wrap: anywhere; }
.rt.rt--plain { white-space: pre-wrap; }
.rt > :first-child { margin-block-start: 0; }
.rt > :last-child { margin-block-end: 0; }
.rt h1, .rt h2, .rt h3, .rt h4 { line-height: 1.15; margin-block: 0.4em 0.25em; }
.rt p, .rt ul, .rt ol, .rt blockquote, .rt pre, .rt table { margin-block: 0 0.5em; }
.rt ul, .rt ol { padding-inline-start: 1.2em; }
.rt blockquote { margin-inline: 0; padding-inline-start: 0.6em; border-inline-start: 0.15em solid currentColor; opacity: 0.85; }
.rt hr { border: 0; border-block-start: 1px solid currentColor; opacity: 0.4; }
.rt table { border-collapse: collapse; }
.rt th, .rt td { padding: 0.15em 0.5em; border: 1px solid currentColor; text-align: start; }
.rt code, .rt pre { font-family: ui-monospace, 'IBM Plex Mono', monospace; font-size: 0.9em; }
.rt img, .rt video { max-inline-size: 100%; block-size: auto; }
.rt a { color: inherit; }
`;
