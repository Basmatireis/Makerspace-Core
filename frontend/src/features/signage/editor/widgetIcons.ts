// Icons of the widget types in the palette, the blocks list and the toolbars.
import {
  Bullhorn,
  Calendar,
  Camera,
  CarouselHorizontal,
  Dashboard,
  EventSchedule,
  Events,
  Hourglass,
  Image,
  ListBulleted,
  QrCode,
  Select_01,
  TextFont,
  Time,
  Video,
  type CarbonIconType,
} from '@carbon/icons-react';
import type { WidgetType } from '../widgets';

export const WIDGET_ICONS: Record<WidgetType, CarbonIconType> = {
  empty: Select_01,
  text: TextFont,
  image: Image,
  video: Video,
  slideshow: CarouselHorizontal,
  qr: QrCode,
  clock: Time,
  status: Dashboard,
  camera: Camera,
  timelapse: Hourglass,
  open_days: EventSchedule,
  events: Events,
  agenda: ListBulleted,
  calendar: Calendar,
  announcement: Bullhorn,
};

/** What an empty block offers to show right on the canvas. */
export const QUICK_PICKS: readonly WidgetType[] = ['text', 'image', 'clock', 'status', 'open_days', 'qr', 'camera'];

/** Drag data type of a palette item; the value is the widget type. */
export const PALETTE_MIME = 'application/x-signage-widget';
