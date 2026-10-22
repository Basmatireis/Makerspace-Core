import type { CSSProperties } from 'react';
import type { SignageStyleAlign, SignageWidget, SignageWidgetStyle } from '../../../api/generated/models';

// Widget style: colours, padding, radius, border, font scale, font family and alignment of a zone box, plus the font
// assets a scene needs. Sizes use --sg-u, the unscaled unit of the scene; --u inside the box is scaled by `fontScale`.

const FONT_STACKS = {
  sans: "'IBM Plex Sans', system-ui, sans-serif",
  serif: "'IBM Plex Serif', Georgia, 'Times New Roman', serif",
  mono: "'IBM Plex Mono', ui-monospace, 'Courier New', monospace",
} as const;

/** A CSS string literal; backslashes, quotes and line breaks cannot end it early. */
export const cssString = (value: string) => `"${value.replace(/[\\"]/g, '\\$&').replace(/[\r\n\f]+/g, ' ')}"`;

/** The box style of a widget: `boxStyle` for announcements (their `style` picks banner/card/full), `style` otherwise. */
export function widgetStyleOf(widget: SignageWidget): SignageWidgetStyle | undefined {
  return widget.type === 'announcement' ? widget.boxStyle : widget.style;
}

/** The font assets of a widget: its style's custom font and the fonts its rich text CSS uses. */
export function fontAssetIdsOf(widget: SignageWidget): string[] {
  const style = widgetStyleOf(widget);
  const ids = [
    ...(style?.fontFamily === 'custom' && style.fontAssetId ? [style.fontAssetId] : []),
    ...('fontAssetIds' in widget ? (widget.fontAssetIds ?? []) : []),
  ];
  return [...new Set(ids)];
}

/** `rgba()` of a `#rrggbb` colour. */
export function withOpacity(hex: string, opacity: number): string {
  const value = /^#([0-9a-f]{6})$/i.exec(hex)?.[1];
  if (!value) return hex;
  const channel = (offset: number) => parseInt(value.slice(offset, offset + 2), 16);
  return `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, ${Math.min(100, Math.max(0, opacity)) / 100})`;
}

const FLEX_ALIGN: Record<Exclude<SignageStyleAlign, 'inherit'>, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
};

/** Horizontal alignment a style asks for; null leaves the widget's own. */
export const styleTextAlign = (style: SignageWidgetStyle | undefined): 'start' | 'center' | 'end' | null =>
  style && style.align !== 'inherit' ? style.align : null;

/**
 * CSS of the zone box for a style. `fontName` is the name of the custom font asset (its @font-face family); a custom
 * font whose name is unknown keeps the inherited font.
 */
export function zoneBoxCss(style: SignageWidgetStyle, fontName: string | null): CSSProperties {
  const css: Record<string, string> = {
    padding: `calc(var(--sg-u) * ${style.padding})`,
    borderRadius: `calc(var(--sg-u) * ${style.radius})`,
    '--u': style.fontScale === 100 ? 'var(--sg-u)' : `calc(var(--sg-u) * ${style.fontScale / 100})`,
  };
  if (style.textColor) css.color = style.textColor;
  if (style.backgroundColor)
    css.background =
      style.backgroundOpacity >= 100
        ? style.backgroundColor
        : withOpacity(style.backgroundColor, style.backgroundOpacity);
  if (style.borderWidth > 0)
    css.border = `calc(var(--sg-u) * ${style.borderWidth / 10}) solid ${style.borderColor ?? 'currentColor'}`;
  if (style.fontFamily === 'custom') {
    if (fontName) css.fontFamily = `${cssString(fontName)}, ${FONT_STACKS.sans}`;
  } else if (style.fontFamily !== 'inherit') css.fontFamily = FONT_STACKS[style.fontFamily];
  if (style.align !== 'inherit') css.textAlign = style.align;
  if (style.verticalAlign !== 'inherit') {
    css.alignItems = FLEX_ALIGN[style.verticalAlign];
    css['--sg-valign'] = FLEX_ALIGN[style.verticalAlign];
  }
  return css as CSSProperties;
}

export type FontFace = { family: string; url: string };

const registered = new WeakMap<Document, Set<string>>();

/** Adds `@font-face` rules to the document, each family and URL once. Fonts are loaded from the asset URL. */
export function registerFontFaces(fonts: readonly FontFace[], doc: Document = document): void {
  let seen = registered.get(doc);
  if (!seen) {
    seen = new Set();
    registered.set(doc, seen);
  }
  const rules: string[] = [];
  for (const font of fonts) {
    const key = `${font.family}\n${font.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push(
      `@font-face { font-family: ${cssString(font.family)}; src: url(${cssString(font.url)}) format("woff2"); font-display: swap; }`,
    );
  }
  if (rules.length === 0) return;
  const style = doc.createElement('style');
  style.setAttribute('data-signage-fonts', '');
  style.textContent = rules.join('\n');
  doc.head.append(style);
}
