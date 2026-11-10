import type {
  SignageBlock,
  SignageBlockStyle,
  SignageCalendarColors,
  SignageRichTextFormat,
  SignageWidget,
} from '../../api/generated/models';
import { isMediaWidget } from './render/style';

// The widget and block model shared by the scene editor, the media page and previews: defaults, the references a scene
// holds, and validation that mirrors the backend (backend/internal/signage/blocks.go and widgets.go).

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
  timelapse: 'Timelapses',
  announcement: 'Announcement',
};
export const WIDGET_TYPES = Object.keys(WIDGET_LABELS) as WidgetType[];

// Limits mirror backend/internal/signage/blocks.go and widgets.go.
export const LIMITS = {
  blocks: 40,
  blockName: 60,
  blockCoordinate: 8000,
  blockMinExtent: 8,
  blockMaxExtent: 8000,
  text: 20000,
  css: 20000,
  fonts: 10,
  listCount: 20,
  listTitle: 200,
  listEmpty: 500,
  entryTemplate: 5000,
  calendarWeeks: 6,
  announcementBody: 5000,
  timelapseMachines: 20,
  timelapseCount: 20,
  timelapseMaxAgeDays: 365,
  timelapseMinSeconds: 5,
  timelapseMaxSeconds: 600,
} as const;

export const DEFAULT_CALENDAR_COLORS: SignageCalendarColors = {
  holiday: '#fa4d56',
  break: '#a56eff',
  openDay: '#42be65',
  event: '#4589ff',
};

/** Widgets whose blocks were padded by default (2u) before blocks; new blocks of these types get the same padding. */
const PADDED_TYPES: readonly WidgetType[] = [
  'text',
  'status',
  'clock',
  'open_days',
  'events',
  'agenda',
  'calendar',
  'qr',
];
/** Widgets that are centred vertically by default. */
const CENTERED_TYPES: readonly WidgetType[] = ['text', 'clock', 'qr', 'status', 'announcement', 'camera'];

/**
 * The style of a new block of a widget type: the look an unstyled zone of that widget had before blocks (the same
 * defaults the server's layout conversion uses), so new and converted blocks match. `textSize` 50 is a text's old
 * size "m"; 32 is every other widget's default look.
 */
export function defaultBlockStyle(type: WidgetType): SignageBlockStyle {
  const plainText = type === 'text';
  return {
    backgroundColor: null,
    backgroundOpacity: 100,
    backgroundAssetId: null,
    backgroundDim: 0,
    textColor: null,
    borderWidth: 0,
    borderStyle: 'solid',
    borderColor: null,
    radius: 0,
    shadow: 'none',
    fontFamily: 'inherit',
    fontAssetId: null,
    fontWeight: plainText ? '600' : 'inherit',
    lineHeight: plainText || type === 'announcement' ? 115 : 125,
    letterSpacing: 0,
    uppercase: false,
    textSize: type === 'text' || type === 'announcement' ? 50 : 32,
    padding: PADDED_TYPES.includes(type) ? 22 : 0,
    align: type === 'clock' || type === 'qr' ? 'center' : 'start',
    verticalAlign: CENTERED_TYPES.includes(type) ? 'center' : 'start',
    opacity: 100,
  };
}

export function defaultWidget(type: WidgetType): SignageWidget {
  switch (type) {
    case 'empty':
      return { type };
    case 'image':
    case 'video':
      return type === 'image' ? { type, mediaId: null, fit: 'cover', dim: 0 } : { type, mediaId: null, fit: 'cover' };
    case 'slideshow':
      return { type, mediaIds: [], seconds: 8 };
    case 'text':
      return { type, text: 'Your text', fit: false };
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
        showLive: true,
        showName: true,
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
    case 'timelapse':
      return {
        type,
        source: 'all',
        machineIds: [],
        count: 5,
        maxAgeDays: 30,
        maxSeconds: 30,
        transition: 'fade',
        showCaption: true,
        fit: 'cover',
      };
    case 'announcement':
      return {
        type,
        templateIds: [],
        style: 'banner',
        whenNone: 'empty',
        fallbackText: '',
        whenMany: 'rotate',
        rotateSeconds: 10,
      };
  }
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

/** Asset ids a widget points at, fonts of its rich text CSS included (a font cannot be deleted while it is referenced). */
export function widgetAssetIds(widget: SignageWidget): string[] {
  const fonts = isRichTextWidget(widget) ? (widget.fontAssetIds ?? []) : [];
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

/** Asset ids of a block: its widget's and its style's background image and custom font. */
export const blockAssetIds = (block: Pick<SignageBlock, 'widget' | 'style'>): string[] => [
  ...widgetAssetIds(block.widget),
  ...(block.style.backgroundAssetId ? [block.style.backgroundAssetId] : []),
  ...(block.style.fontAssetId ? [block.style.fontAssetId] : []),
];

/**
 * Asset ids a scene points at: background, scene font and every block, hidden ones included (the scene still
 * references them, so they cannot be deleted).
 */
export const sceneAssetIds = (scene: {
  backgroundAssetId: string | null;
  fontAssetId?: string | null;
  blocks: readonly Pick<SignageBlock, 'widget' | 'style'>[];
}): string[] => [
  ...new Set([
    ...(scene.backgroundAssetId ? [scene.backgroundAssetId] : []),
    ...(scene.fontAssetId ? [scene.fontAssetId] : []),
    ...scene.blocks.flatMap(blockAssetIds),
  ]),
];

/** Widgets of the blocks a display shows (hidden blocks are left out). */
export const visibleWidgets = (blocks: readonly Pick<SignageBlock, 'widget' | 'hidden'>[]): SignageWidget[] =>
  blocks.filter((block) => !block.hidden).map((block) => block.widget);

/** Machines a scene's widgets point at, so previews can show them even without access to the machine list. */
export const sceneMachineIds = (blocks: readonly Pick<SignageBlock, 'widget'>[]): string[] => [
  ...new Set(
    blocks.flatMap(({ widget }) => {
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
  { key: 'competencies', label: 'Planned competencies, e.g. 3D printing, Laser cutting', for: 'open_day' },
];

const SINGLE_LINE = /[\r\n]/;

const within = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;
const COLOR = /^#[0-9a-f]{6}$/;

/** Checks a block style the way the backend does (ValidateBlockStyle); colours are lowercase `#rrggbb` or null. */
export function blockStyleError(style: SignageBlockStyle, type: WidgetType): string | null {
  for (const color of [style.textColor, style.backgroundColor, style.borderColor])
    if (color !== null && !COLOR.test(color)) return 'Style colours must be #rrggbb.';
  if (
    !within(style.backgroundOpacity, 0, 100) ||
    !within(style.backgroundDim, 0, 90) ||
    !within(style.borderWidth, 0, 40) ||
    !within(style.radius, 0, 400) ||
    !within(style.padding, 0, 400) ||
    !within(style.lineHeight, 80, 250) ||
    !within(style.letterSpacing, -10, 50) ||
    !within(style.textSize, 8, 400) ||
    !within(style.opacity, 10, 100)
  )
    return 'A style value is out of range.';
  if ((style.fontFamily === 'custom') !== (style.fontAssetId !== null))
    return 'Choose a font for the custom font family.';
  if (isMediaWidget(type) && (style.backgroundAssetId !== null || style.backgroundDim !== 0))
    return 'This block shows a picture and has no background image.';
  return null;
}

/** Checks a block's id, name and geometry, then its widget and style. */
export function blockError(block: SignageBlock): string | null {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(block.id)) return 'A block id is 1 to 40 letters, digits, underscores or hyphens.';
  if (block.name.trim() === '' || [...block.name].length > LIMITS.blockName)
    return `A block name is 1 to ${LIMITS.blockName} characters.`;
  if (
    !within(block.x, -LIMITS.blockCoordinate, LIMITS.blockCoordinate) ||
    !within(block.y, -LIMITS.blockCoordinate, LIMITS.blockCoordinate) ||
    !within(block.w, LIMITS.blockMinExtent, LIMITS.blockMaxExtent) ||
    !within(block.h, LIMITS.blockMinExtent, LIMITS.blockMaxExtent)
  )
    return 'A block position or size is out of range.';
  return widgetError(block.widget) ?? blockStyleError(block.style, block.widget.type);
}

/** Checks the blocks of a scene: at most 40, unique ids, each valid. */
export function blocksError(blocks: readonly SignageBlock[]): string | null {
  if (blocks.length > LIMITS.blocks) return `A screen holds at most ${LIMITS.blocks} blocks.`;
  if (new Set(blocks.map((block) => block.id)).size !== blocks.length) return 'Block ids must be unique.';
  for (const block of blocks) {
    const problem = blockError(block);
    if (problem) return `${block.name}: ${problem}`;
  }
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

function timelapseError(widget: Extract<SignageWidget, { type: 'timelapse' }>): string | null {
  const distinct = new Set(widget.machineIds).size;
  if (widget.source === 'machines' && distinct === 0) return 'Choose at least one machine.';
  if (widget.source === 'all' && widget.machineIds.length > 0) return 'All machines lists no machines.';
  if (distinct !== widget.machineIds.length) return 'Each machine can be chosen once.';
  if (widget.machineIds.length > LIMITS.timelapseMachines)
    return `A timelapse widget lists at most ${LIMITS.timelapseMachines} machines.`;
  if (!within(widget.count, 1, LIMITS.timelapseCount)) return `Show between 1 and ${LIMITS.timelapseCount} clips.`;
  if (!within(widget.maxAgeDays, 0, LIMITS.timelapseMaxAgeDays))
    return `The maximum age is 0 (any) to ${LIMITS.timelapseMaxAgeDays} days.`;
  return within(widget.maxSeconds, LIMITS.timelapseMinSeconds, LIMITS.timelapseMaxSeconds)
    ? null
    : `A clip plays ${LIMITS.timelapseMinSeconds} to ${LIMITS.timelapseMaxSeconds} seconds.`;
}

/** Mirrors the backend widget validation (widgets.go) so autosave does not send what is certain to be rejected. */
export function widgetError(widget: SignageWidget): string | null {
  switch (widget.type) {
    case 'image':
      return within(widget.dim, 0, 90) ? null : 'Darken the image by 0 to 90 %.';
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
    case 'timelapse':
      return timelapseError(widget);
    case 'announcement':
      if (widget.rotateSeconds < 3 || widget.rotateSeconds > 300) return 'Rotate every 3 to 300 seconds.';
      return widget.fallbackText.length > 500 ? 'The fallback text is limited to 500 characters.' : null;
    default:
      return null;
  }
}
