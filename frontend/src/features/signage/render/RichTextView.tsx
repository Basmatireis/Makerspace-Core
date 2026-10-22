import { useEffect, useRef, useState } from 'react';
import type { RichTextFormat } from './escape';
import { loadedRichText, loadRichText } from './loadRichText';

// Renders markdown or sanitized HTML/CSS (see richText.ts) into a shadow root, so author CSS only affects its own box and
// `var(--u)` and the inherited text colour, font and alignment still apply. The sanitizer and markdown renderer are about
// 20 kB gzip; they are loaded on first use so the player's initial JavaScript stays small (its service worker precaches
// the chunk). Plain text without CSS never needs them and renders as text nodes right away.

export type RichTextProps = {
  /** Absent means plain. */
  format?: RichTextFormat;
  /** The document in `format`; placeholders must already be filled (and escaped for the format). */
  text: string;
  /** Author CSS, sanitized and scoped to this document. Ignored for plain text. */
  css?: string;
  className?: string;
};

function RichDocument({ format, text, css = '', className }: RichTextProps) {
  const host = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(loadedRichText);
  useEffect(() => {
    if (loaded) return;
    let active = true;
    loadRichText().then(
      (module) => {
        if (active) setLoaded(module);
      },
      () => undefined, // The document stays empty; the next mount tries again.
    );
    return () => {
      active = false;
    };
  }, [loaded]);
  useEffect(() => {
    const element = host.current;
    if (!element || !loaded) return;
    const root = element.shadowRoot ?? element.attachShadow({ mode: 'open' });
    const result = loaded.renderRichText({ format, text, css });
    const base = document.createElement('style');
    base.textContent = loaded.RICH_TEXT_BASE_CSS;
    const author = document.createElement('style');
    author.textContent = result.css;
    const body = document.createElement('div');
    body.className = 'rt';
    // Sanitized by renderRichText; the shadow root keeps the markup and its CSS away from the rest of the page.
    body.innerHTML = result.html;
    root.replaceChildren(base, author, body);
  }, [loaded, format, text, css]);
  return <div ref={host} className={`sg-rich${className ? ` ${className}` : ''}`} />;
}

export function RichText(props: RichTextProps) {
  if (!props.format || props.format === 'plain')
    return <div className={`sg-rich sg-rich--plain${props.className ? ` ${props.className}` : ''}`}>{props.text}</div>;
  return <RichDocument {...props} />;
}
