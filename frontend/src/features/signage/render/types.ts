import type { ReactNode } from 'react';
import type {
  SignageOrientation,
  SignagePlayerCalendar,
  SignageScene,
  SignageTone,
} from '../../../api/generated/models';
import type { CustomLayoutShape } from '../layouts';
import type { RichTextFormat } from './escape';

// Data contract of the shared scene renderer. The renderer is plain React and plain CSS: no Carbon, no TanStack Query
// and no imports from src/app, because the separate player app imports it too. Widgets get everything through props.

export type RenderScene = Pick<
  SignageScene,
  | 'orientation'
  | 'layoutId'
  | 'backgroundColor'
  | 'backgroundAssetId'
  | 'backgroundFit'
  | 'backgroundDim'
  | 'theme'
  | 'zones'
> & {
  /** Names the custom layout (in `RenderData.customLayouts`) when `layoutId` is `custom`. */
  customLayoutId?: string | null;
};

export type MachineState = 'idle' | 'preparing' | 'printing' | 'paused' | 'finished' | 'failed' | 'unknown';

export type RenderMachine = {
  machineId: string;
  name: string;
  state: MachineState;
  progressPercent: number | null;
  remainingMinutes: number | null;
  /** True when the status is older than the live-data TTL; the widget then shows "Status unknown". */
  stale: boolean;
};

/** A machine counts as printing while a job is prepared, running or paused. */
export const isPrinting = (machine: Pick<RenderMachine, 'state' | 'stale'>) =>
  !machine.stale && (machine.state === 'preparing' || machine.state === 'printing' || machine.state === 'paused');

/** An announcement already rendered to text (see engine/announcements.ts or the live response). */
export type RenderAnnouncement = {
  id: string;
  templateId: string;
  tone: SignageTone;
  title: string;
  /** Placeholder values are already escaped for `bodyFormat`. */
  body: string;
  /** Absent means plain. */
  bodyFormat?: RichTextFormat;
  bodyCss?: string;
  startsAt: number;
};

/** `competencies` holds the public labels of the planned support; data cached by an older player may lack it. */
export type RenderOpenDay = { startsAt: string; endsAt: string; status: string; competencies?: readonly string[] };
export type RenderEvent = { title: string; startsAt: string; endsAt?: string | null; location: string | null };

export type RenderData = {
  /** Epoch milliseconds; drives clocks, slideshows, rotation. */
  now: number;
  /** False when live data is unavailable: machine status shows "Status unknown" and cameras fall back. */
  liveAvailable: boolean;
  machines: readonly RenderMachine[];
  /** Machines whose camera cannot be reached; their camera widgets show the configured fallback. */
  unavailableCameras?: ReadonlySet<string>;
  announcements: readonly RenderAnnouncement[];
  openDays: readonly RenderOpenDay[];
  events: readonly RenderEvent[];
  /** Data of the calendar widget; null or absent renders the grid without entries. */
  calendar?: SignagePlayerCalendar | null;
  /** The custom layouts scenes may use (the manifest's, or the admin list). */
  customLayouts?: readonly CustomLayoutShape[];
  /** Asset id to URL; null when the asset is unknown (it renders as a placeholder). */
  assetUrl: (assetId: string) => string | null;
  /** Asset id to name; fonts are registered under their asset name, so CSS can use it as `font-family`. */
  assetName?: (assetId: string) => string | null;
  /** The live picture of a machine's camera (the player's camera source); null keeps the neutral frame. */
  cameraView?: (machine: RenderMachine) => ReactNode;
  /** Overrides the camera widget's own "several machines print" setting when a rule decided it. */
  multiMode?: 'split' | 'alternate' | null;
  alternateSeconds?: number;
  /** IANA time zone for clocks and dates; defaults to the device's. */
  timeZone?: string;
  /** Thumbnails: videos and slideshows stay still. */
  still?: boolean;
};

export type { SignageOrientation };
