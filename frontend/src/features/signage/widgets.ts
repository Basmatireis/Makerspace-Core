import type {
  SignageCalendarColors,
  SignageRichTextFormat,
  SignageWidget,
  SignageWidgetStyle,
  SignageZones,
} from '../../api/generated/models';

export type WidgetType = SignageWidget['type'];

export const WIDGET_LABELS: Record<WidgetType, string> = {
  empty: 'Empty',
  image: 'Image',
  video: 'Video',
  slideshow: 'Slideshow',
  text: 'Text',
  qr: 'QR code',
  clock: 'Clock',
  camera: 'Camera',
  status: 'Machine status',
  open_days: 'Open days',
  events: 'Events',
  agenda: 'Agenda',
  calendar: 'Calendar',
  announcement: 'Announcement',
};
export const WIDGET_TYPES = Object.keys(WIDGET_LABELS) as WidgetType[];

// Limits mirror backend/internal/signage/zones.go.
export const LIMITS = {
  text: 20000,
  css: 20000,
  fonts: 10,
  listCount: 20,
  listTitle: 200,
  listEmpty: 500,
  entryTemplate: 5000,
  calendarWeeks: 6,
  announcementBody: 5000,
} as const;

export const DEFAULT_CALENDAR_COLORS: SignageCalendarColors = {
  holiday: '#fa4d56',
  break: '#a56eff',
  openDay: '#42be65',
  event: '#4589ff',
};

export const defaultStyle = (): SignageWidgetStyle => ({
  textColor: null,
  backgroundColor: null,
  borderColor: null,
  backgroundOpacity: 100,
  padding: 0,
  radius: 0,
  borderWidth: 0,
  fontScale: 100,
  fontFamily: 'inherit',
  fontAssetId: null,
  align: 'inherit',
  verticalAlign: 'inherit',
});

export function defaultWidget(type: WidgetType): SignageWidget {
  switch (type) {
    case 'empty':
      return { type };
    case 'image':
    case 'video':
      return { type, mediaId: null, fit: 'cover' };
    case 'slideshow':
      return { type, mediaIds: [], seconds: 8 };
    case 'text':
      return { type, text: 'Your text', size: 'm', align: 'start' };
    case 'qr':
      return { type, url: 'https://', caption: 'Scan for details' };
    case 'clock':
      return { type, mode: 'time' };
    case 'camera':
      return {
        type,
        source: 'auto',
        machineId: null,
        multi: 'split',
        showProgress: true,
        showRemaining: true,
        fallback: 'text',
        fallbackMediaId: null,
        machineIds: [],
      };
    case 'status':
      return { type, machineIds: [], showProgress: true, showRemaining: true };
    case 'open_days':
    case 'events':
      return { type, count: 3 };
    case 'agenda':
      return { type, count: 5, includeOpenDays: true, includeEvents: true };
    case 'calendar':
      return {
        type,
        view: 'month',
        weeks: 4,
        showHolidays: true,
        showBreaks: true,
        showOpenDays: true,
        showEvents: true,
        colors: { ...DEFAULT_CALENDAR_COLORS },
        showWeekNumbers: false,
      };
    case 'announcement':
      return {
        type,
        templateIds: [],
        style: 'banner',
        size: 'm',
        whenNone: 'empty',
        fallbackText: '',
        whenMany: 'rotate',
        rotateSeconds: 10,
      };
  }
}

/** The zone box style of a widget: `boxStyle` on announcements (where `style` picks the presentation), `style` elsewhere. */
export const styleOf = (widget: SignageWidget): SignageWidgetStyle | undefined =>
  widget.type === 'announcement' ? widget.boxStyle : widget.style;

/** Sets or, with undefined, removes the zone box style. */
export function withStyle(widget: SignageWidget, style: SignageWidgetStyle | undefined): SignageWidget {
  const key = widget.type === 'announcement' ? 'boxStyle' : 'style';
  const next: Record<string, unknown> = { ...widget };
  if (style) next[key] = style;
  else delete next[key];
  return next as unknown as SignageWidget;
}

/** Sets an optional widget field; undefined removes it so absent keeps meaning "as before". */
export function withField<W extends SignageWidget>(widget: W, key: string, value: unknown): W {
  const next: Record<string, unknown> = { ...widget };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next as W;
}

export type RichTextWidget = Extract<SignageWidget, { type: 'text' | 'open_days' | 'events' | 'agenda' }>;
export const isRichTextWidget = (widget: SignageWidget): widget is RichTextWidget =>
  widget.type === 'text' || widget.type === 'open_days' || widget.type === 'events' || widget.type === 'agenda';

export const formatOf = (widget: RichTextWidget): SignageRichTextFormat => widget.format ?? 'plain';

/** Applies rich text edits and drops what is at its default, so absent still means "as before". */
export function withRichText<W extends RichTextWidget>(
  widget: W,
  patch: { format?: SignageRichTextFormat; css?: string; fontAssetIds?: string[] },
): W {
  const next = { ...widget, ...patch } as W;
  if (next.format === 'plain') delete next.format;
  if (!next.css) delete next.css;
  if (!next.fontAssetIds || next.fontAssetIds.length === 0) delete next.fontAssetIds;
  return next;
}

/** Asset ids a widget points at, fonts included (a font cannot be deleted while it is referenced). */
export function widgetAssetIds(widget: SignageWidget): string[] {
  const style = styleOf(widget);
  const fonts = [...(style?.fontAssetId ? [style.fontAssetId] : [])];
  if (isRichTextWidget(widget)) fonts.push(...(widget.fontAssetIds ?? []));
  switch (widget.type) {
    case 'image':
    case 'video':
      return [...(widget.mediaId ? [widget.mediaId] : []), ...fonts];
    case 'slideshow':
      return [...widget.mediaIds, ...fonts];
    case 'camera':
      return [...(widget.fallback === 'image' && widget.fallbackMediaId ? [widget.fallbackMediaId] : []), ...fonts];
    default:
      return fonts;
  }
}

export const sceneAssetIds = (scene: { backgroundAssetId: string | null; zones: SignageZones }): string[] => [
  ...(scene.backgroundAssetId ? [scene.backgroundAssetId] : []),
  ...Object.values(scene.zones).flatMap(widgetAssetIds),
];

/** Machines a scene's widgets point at, so previews can show them even without access to the machine list. */
export const sceneMachineIds = (zones: SignageZones): string[] => [
  ...new Set(
    Object.values(zones).flatMap((widget) => {
      if (widget.type === 'camera')
        return [...(widget.machineId ? [widget.machineId] : []), ...(widget.machineIds ?? [])];
      return widget.type === 'status' ? widget.machineIds : [];
    }),
  ),
];

export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Typed numbers are applied once they are numbers (an emptied field keeps the last value) and kept within the limits. */
export const clampInt = (value: unknown, min: number, max: number): number | null => {
  const number = Number(value);
  return value === '' || !Number.isFinite(number) ? null : Math.min(max, Math.max(min, Math.round(number)));
};

/** Placeholders of list entry templates; the server and the player replace `{name}` with the escaped value. */
export const ENTRY_PLACEHOLDERS: { key: string; label: string; for: 'both' | 'open_day' | 'event' }[] = [
  { key: 'kind', label: 'Open day or Event', for: 'both' },
  { key: 'title', label: 'Title', for: 'both' },
  { key: 'date', label: 'Date, e.g. Thu 23 Oct', for: 'both' },
  { key: 'weekday', label: 'Weekday', for: 'both' },
  { key: 'weekday_short', label: 'Short weekday', for: 'both' },
  { key: 'day', label: 'Day of month', for: 'both' },
  { key: 'month', label: 'Month', for: 'both' },
  { key: 'month_short', label: 'Short month', for: 'both' },
  { key: 'year', label: 'Year', for: 'both' },
  { key: 'start', label: 'Start time', for: 'both' },
  { key: 'end', label: 'End time', for: 'both' },
  { key: 'status', label: 'Scheduled or Cancelled', for: 'open_day' },
  { key: 'location', label: 'Location', for: 'event' },
];

const SINGLE_LINE = /[\r\n]/;

/** Checks a style the way the backend does; colours are lowercase `#rrggbb` or null. */
export function styleError(style: SignageWidgetStyle): string | null {
  for (const color of [style.textColor, style.backgroundColor, style.borderColor])
    if (color !== null && !/^#[0-9a-f]{6}$/.test(color)) return 'Style colours must be #rrggbb.';
  const within = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;
  if (
    !within(style.backgroundOpacity, 0, 100) ||
    !within(style.padding, 0, 10) ||
    !within(style.radius, 0, 10) ||
    !within(style.borderWidth, 0, 20) ||
    !within(style.fontScale, 25, 400)
  )
    return 'A style value is out of range.';
  if ((style.fontFamily === 'custom') !== (style.fontAssetId !== null))
    return 'Choose a font for the custom font family.';
  return null;
}

function richTextError(widget: RichTextWidget): string | null {
  if ((widget.css?.length ?? 0) > LIMITS.css) return `The CSS is limited to ${LIMITS.css} characters.`;
  return (widget.fontAssetIds?.length ?? 0) > LIMITS.fonts ? `At most ${LIMITS.fonts} fonts can be used.` : null;
}

function listError(widget: Extract<SignageWidget, { type: 'open_days' | 'events' | 'agenda' }>): string | null {
  if (!Number.isInteger(widget.count) || widget.count < 1 || widget.count > LIMITS.listCount)
    return `Choose between 1 and ${LIMITS.listCount}.`;
  if (widget.title !== undefined && (widget.title.length > LIMITS.listTitle || SINGLE_LINE.test(widget.title)))
    return `The title is one line of up to ${LIMITS.listTitle} characters.`;
  if ((widget.emptyText?.length ?? 0) > LIMITS.listEmpty)
    return `The empty text is limited to ${LIMITS.listEmpty} characters.`;
  const templates = widget.type === 'agenda' ? [widget.openDayTemplate, widget.eventTemplate] : [widget.entryTemplate];
  if (templates.some((template) => (template?.length ?? 0) > LIMITS.entryTemplate))
    return `A template is limited to ${LIMITS.entryTemplate} characters.`;
  return richTextError(widget);
}

/** Mirrors the backend widget validation (zones.go) so autosave does not send what is certain to be rejected. */
export function widgetError(widget: SignageWidget): string | null {
  const style = styleOf(widget);
  const problem = style ? styleError(style) : null;
  if (problem) return problem;
  switch (widget.type) {
    case 'text':
      return widget.text.length > LIMITS.text ? `Text is limited to ${LIMITS.text} characters.` : richTextError(widget);
    case 'qr':
      if (widget.url.length > 500) return 'The URL is limited to 500 characters.';
      if (widget.caption.length > 200) return 'The caption is limited to 200 characters.';
      try {
        const url = new URL(widget.url);
        return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === ''
          ? null
          : 'Enter an https:// URL without credentials.';
      } catch {
        return 'Enter an https:// URL without credentials.';
      }
    case 'camera':
      if (widget.source === 'machine' && !widget.machineId) return 'Choose a machine.';
      return (widget.machineIds?.length ?? 0) > 20 ? 'A camera widget lists at most 20 machines.' : null;
    case 'slideshow':
      return widget.seconds < 3 || widget.seconds > 3600
        ? 'Seconds per slide must be between 3 and 3600.'
        : widget.mediaIds.length > 50
          ? 'A slideshow holds at most 50 images.'
          : null;
    case 'open_days':
    case 'events':
    case 'agenda':
      return listError(widget);
    case 'calendar':
      if (!Number.isInteger(widget.weeks) || widget.weeks < 1 || widget.weeks > LIMITS.calendarWeeks)
        return `Show between 1 and ${LIMITS.calendarWeeks} weeks.`;
      if (Object.values(widget.colors).some((color) => !/^#[0-9a-f]{6}$/.test(color)))
        return 'Calendar colours must be #rrggbb.';
      return widget.title !== undefined && (widget.title.length > LIMITS.listTitle || SINGLE_LINE.test(widget.title))
        ? `The title is one line of up to ${LIMITS.listTitle} characters.`
        : null;
    case 'announcement':
      if (widget.rotateSeconds < 3 || widget.rotateSeconds > 300) return 'Rotate every 3 to 300 seconds.';
      return widget.fallbackText.length > 500 ? 'The fallback text is limited to 500 characters.' : null;
    default:
      return null;
  }
}
