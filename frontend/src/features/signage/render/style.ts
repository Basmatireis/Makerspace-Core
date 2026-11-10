import type { CSSProperties } from 'react';
import type { SignageBlock, SignageBlockAlign, SignageBlockStyle, SignageWidget } from '../../../api/generated/models';
import { GRID_UNIT } from './aspect';

// Block style: the box of a block (position, background, border, shadow, opacity), its typography and the unit `--u`
// its widget is sized in, plus the font assets a scene needs. Every length is in grid units, i.e. CSS pixels of the
// unscaled scene (see sceneGridSize).

export const FONT_STACKS = {
  sans: "'IBM Plex Sans', system-ui, sans-serif",
  serif: "'IBM Plex Serif', Georgia, 'Times New Roman', serif",
  mono: "'IBM Plex Mono', ui-monospace, 'Courier New', monospace",
} as const;

/** A CSS string literal; backslashes, quotes and line breaks cannot end it early. */
export const cssString = (value: string) => `"${value.replace(/[\\"]/g, '\\$&').replace(/[\r\n\f]+/g, ' ')}"`;

/** A CSS `url()` of a URL; quotes, backslashes and line breaks are percent-encoded. */
export const cssUrl = (url: string) => `url("${url.replace(/["\\\n]/g, encodeURIComponent)}")`;

type WidgetType = SignageWidget['type'];

/** Widgets that fill their block with a picture; their blocks have no background image (the server enforces it). */
export const MEDIA_WIDGET_TYPES: readonly WidgetType[] = ['image', 'video', 'slideshow', 'camera', 'timelapse'];
export const isMediaWidget = (type: WidgetType) => MEDIA_WIDGET_TYPES.includes(type);

/** For text and announcement blocks `textSize` is a font size; every other widget scales its sizes with it. */
export const textSizeIsFontSize = (type: WidgetType) => type === 'text' || type === 'announcement';

/** `textSize` of the default look of non-text widgets (the old 100 % font scale). */
export const DEFAULT_TEXT_SIZE = 32;
/** Font size of the old default text size "m" (4.6u); the paddings of text and announcement blocks are tied to it. */
export const DEFAULT_FONT_SIZE = 50;

/**
 * The widget unit `--u` of a block in CSS pixels. Widget CSS is written in multiples of the old unit (1 % of the short
 * side, 10.8 grid units): `10.8 · textSize / 32`, so 32 is the default look. Text and announcement blocks use
 * `textSize` as their font size; their unit is `10.8 · textSize / 50`, so the old default size "m" keeps its paddings.
 */
export function blockUnit(type: WidgetType, textSize: number): number {
  const reference = textSizeIsFontSize(type) ? DEFAULT_FONT_SIZE : DEFAULT_TEXT_SIZE;
  return Math.round(((GRID_UNIT * textSize) / reference) * 10_000) / 10_000;
}

/** The text colour of a theme; blocks without a text colour inherit it. */
export const sceneTextColor = (theme: 'dark' | 'light') => (theme === 'light' ? '#161616' : '#ffffff');

/** The font assets of a block: its style's custom font and the fonts its rich text CSS uses. */
export function fontAssetIdsOf(block: Pick<SignageBlock, 'style' | 'widget'>): string[] {
  const { style, widget } = block;
  const ids = [
    ...(style.fontFamily === 'custom' && style.fontAssetId ? [style.fontAssetId] : []),
    ...('fontAssetIds' in widget ? (widget.fontAssetIds ?? []) : []),
  ];
  return [...new Set(ids)];
}

/** The scene's `font-family`; a custom font whose name is unknown falls back to sans-serif. */
export function sceneFontCss(
  scene: { fontFamily?: 'sans' | 'serif' | 'mono' | 'custom' },
  fontName: string | null,
): string {
  const family = scene.fontFamily ?? 'sans';
  if (family !== 'custom') return FONT_STACKS[family];
  return fontName ? `${cssString(fontName)}, ${FONT_STACKS.sans}` : FONT_STACKS.sans;
}

/** `rgba()` of a `#rrggbb` colour. */
export function withOpacity(hex: string, opacity: number): string {
  const value = /^#([0-9a-f]{6})$/i.exec(hex)?.[1];
  if (!value) return hex;
  const channel = (offset: number) => parseInt(value.slice(offset, offset + 2), 16);
  return `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, ${Math.min(100, Math.max(0, opacity)) / 100})`;
}

export const FLEX_ALIGN: Record<SignageBlockAlign, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
};

const SHADOWS: Record<Exclude<SignageBlockStyle['shadow'], 'none' | 'glow'>, string> = {
  soft: '0 8px 24px rgba(0, 0, 0, 0.35)',
  strong: '0 18px 48px rgba(0, 0, 0, 0.6)',
};

/** Opacity of hidden blocks in the editor (displays leave them out). */
export const HIDDEN_BLOCK_OPACITY = 0.3;

export type BlockCssContext = {
  /** The scene's text colour (its theme's); the glow falls back to it. */
  sceneTextColor: string;
  /** Name of the style's custom font asset (its @font-face family); unknown keeps the inherited font. */
  fontName: string | null;
  /** URL of the style's background image; null when there is none or it is unknown. */
  backgroundUrl: string | null;
  /** Editor only: the block is hidden on displays and drawn faded. */
  hidden?: boolean;
};

/**
 * CSS of a block's outer box: position and size in grid pixels, background (colour with opacity, image with a black
 * dimming veil, only for non-media widgets), border, radius, shadow, opacity and typography (inherited by the widget).
 * Custom properties: `--u` (widget unit), `--sg-halign`/`--sg-valign` (flex alignment), `--sg-letter-spacing`.
 */
export function blockBoxCss(
  block: Pick<SignageBlock, 'x' | 'y' | 'w' | 'h' | 'style'> & { widget: { type: WidgetType } },
  context: BlockCssContext,
): CSSProperties {
  const { style } = block;
  const type = block.widget.type;
  const css: Record<string, string | number> = {
    left: `${block.x}px`,
    top: `${block.y}px`,
    width: `${block.w}px`,
    height: `${block.h}px`,
    fontSize: `${style.textSize}px`,
    lineHeight: style.lineHeight / 100,
    textAlign: style.align,
    '--u': `${blockUnit(type, style.textSize)}px`,
    '--sg-halign': FLEX_ALIGN[style.align],
    '--sg-valign': FLEX_ALIGN[style.verticalAlign],
  };
  if (style.textColor) css.color = style.textColor;
  if (context.backgroundUrl && !isMediaWidget(type)) {
    const veil = `rgba(0, 0, 0, ${style.backgroundDim / 100})`;
    css.backgroundImage = `${style.backgroundDim > 0 ? `linear-gradient(${veil}, ${veil}), ` : ''}${cssUrl(context.backgroundUrl)}`;
    css.backgroundPosition = 'center';
    css.backgroundSize = 'cover';
    css.backgroundRepeat = 'no-repeat';
  }
  if (style.backgroundColor)
    css.backgroundColor =
      style.backgroundOpacity >= 100
        ? style.backgroundColor
        : withOpacity(style.backgroundColor, style.backgroundOpacity);
  if (style.borderWidth > 0)
    css.border = `${style.borderWidth}px ${style.borderStyle} ${style.borderColor ?? 'currentColor'}`;
  if (style.radius > 0) css.borderRadius = `${style.radius}px`;
  if (style.shadow === 'glow')
    css.boxShadow = `0 0 40px ${withOpacity(style.borderColor ?? style.textColor ?? context.sceneTextColor, 70)}`;
  else if (style.shadow !== 'none') css.boxShadow = SHADOWS[style.shadow];
  if (context.hidden) css.opacity = HIDDEN_BLOCK_OPACITY;
  else if (style.opacity < 100) css.opacity = style.opacity / 100;
  if (style.fontFamily === 'custom') {
    if (context.fontName) css.fontFamily = `${cssString(context.fontName)}, ${FONT_STACKS.sans}`;
  } else if (style.fontFamily !== 'inherit') css.fontFamily = FONT_STACKS[style.fontFamily];
  if (style.fontWeight !== 'inherit') css.fontWeight = Number(style.fontWeight);
  if (style.letterSpacing !== 0) css['--sg-letter-spacing'] = `${style.letterSpacing / 100}em`;
  if (style.uppercase) css.textTransform = 'uppercase';
  return css as CSSProperties;
}

/** Black or white text, whichever reads better on the colour. */
export function readableOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) > 0.179 ? '#161616' : '#ffffff';
}

/** Widget colours a block sets for its content, as custom properties the renderer CSS falls back from. */
export function widgetColorCss(widget: SignageWidget): CSSProperties {
  const css: Record<string, string> = {};
  const put = (name: string, color: string | undefined, withText = false) => {
    if (!color) return;
    css[name] = color;
    if (withText) css[`${name}-text`] = readableOn(color);
  };
  switch (widget.type) {
    case 'status':
      put('--sg-busy', widget.busyColor, true);
      put('--sg-idle', widget.idleColor, true);
      put('--sg-unknown', widget.unknownColor, true);
      put('--sg-progress', widget.progressColor);
      break;
    case 'camera':
      put('--sg-live', widget.liveColor);
      put('--sg-progress', widget.progressColor);
      break;
    case 'timelapse':
      put('--sg-caption', widget.captionColor);
      break;
    case 'open_days':
    case 'events':
    case 'agenda':
      put('--sg-accent', widget.accentColor);
      put('--sg-competency', widget.competencyColor);
      break;
    default:
      break;
  }
  return css as CSSProperties;
}

/** CSS of a block's content box: the padding and the vertical alignment of the widget. */
export const blockInnerCss = (style: Pick<SignageBlockStyle, 'padding' | 'verticalAlign'>): CSSProperties => ({
  padding: style.padding > 0 ? `${style.padding}px` : undefined,
  justifyContent: FLEX_ALIGN[style.verticalAlign],
});

export type FontFace = { family: string; url: string };

type LoadedFace = InstanceType<typeof globalThis.FontFace>;
type FontState = {
  faces: Map<string, LoadedFace>;
  timers: Map<string, number>;
  failures: Map<string, number>;
  styles: Set<string>;
};

const registered = new WeakMap<Document, FontState>();
const RETRY_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];

function loadFace(state: FontState, doc: Document, key: string, font: FontFace): void {
  const face = new globalThis.FontFace(font.family, `url(${cssString(font.url)}) format("woff2")`, { display: 'swap' });
  state.faces.set(key, face);
  doc.fonts.add(face);
  face.load().catch(() => {
    if (state.faces.get(key) !== face || state.timers.has(key)) return;
    const attempt = state.failures.get(key) ?? 0;
    state.failures.set(key, attempt + 1);
    state.timers.set(
      key,
      window.setTimeout(
        () => {
          state.timers.delete(key);
          doc.fonts.delete(face);
          loadFace(state, doc, key, font);
        },
        RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)],
      ),
    );
  });
}

/**
 * Registers the fonts with the document, each family and URL once. Uses the Font Loading API so a failed load is retried
 * (with backoff, and at once on the next call); without it, `@font-face` rules are added to a style element.
 */
export function registerFontFaces(fonts: readonly FontFace[], doc: Document = document): void {
  let state = registered.get(doc);
  if (!state) {
    state = { faces: new Map(), timers: new Map(), failures: new Map(), styles: new Set() };
    registered.set(doc, state);
  }
  const api = typeof globalThis.FontFace !== 'undefined' && !!doc.fonts;
  const rules: string[] = [];
  for (const font of fonts) {
    const key = `${font.family}\n${font.url}`;
    if (api) {
      const face = state.faces.get(key);
      if (face && face.status !== 'error') continue;
      if (face) {
        window.clearTimeout(state.timers.get(key));
        state.timers.delete(key);
        doc.fonts.delete(face);
      }
      loadFace(state, doc, key, font);
      continue;
    }
    if (state.styles.has(key)) continue;
    state.styles.add(key);
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
