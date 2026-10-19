// Domain types of the digital signage prototype. Frontend-only; see DESIGN.md.

export type Orientation = 'portrait' | 'landscape';
export type MachineKey = 'h2d' | 'x1c';
/** Simulated state of a printer: camera_unavailable means "printing, but the camera stream is down". */
export type MachineSim = 'idle' | 'printing' | 'camera_unavailable';

export type Sim = { h2d: MachineSim; x1c: MachineSim; coreReachable: boolean; announcement: boolean };

export type Resolution = { w: number; h: number };

// Widgets ------------------------------------------------------------------------------------------------------------------------
export type TextSize = 's' | 'm' | 'l' | 'xl';
export type MultiMode = 'split' | 'alternate';
export type CameraFallback = 'image' | 'text' | 'hide';

export type Widget =
  | { type: 'empty' }
  | { type: 'image'; mediaId: string | null; fit: 'contain' | 'cover' }
  | { type: 'video'; mediaId: string | null; fit: 'contain' | 'cover' }
  | { type: 'slideshow'; mediaIds: string[]; seconds: number }
  | { type: 'text'; text: string; size: TextSize; align: 'start' | 'center' | 'end' }
  | { type: 'qr'; url: string; caption: string }
  | { type: 'clock'; mode: 'time' | 'datetime' }
  | { type: 'camera'; source: 'machine' | 'auto'; machineId: MachineKey; multi: MultiMode; showProgress: boolean; showRemaining: boolean; fallback: CameraFallback; fallbackMediaId: string | null }
  | { type: 'status'; machineIds: MachineKey[]; showProgress: boolean; showRemaining: boolean }
  | { type: 'open_days'; count: number }
  | { type: 'events'; count: number };

export type WidgetType = Widget['type'];

export type Scene = {
  id: string;
  name: string;
  orientation: Orientation;
  templateId: string;
  /** One widget per zone of the template. */
  zones: Record<string, Widget>;
  background: string;
  /** Optional image behind all zones; the colour still shows around a contained image. */
  backgroundImage?: SceneBackgroundImage | null;
  theme: 'dark' | 'light';
  /** Offered as an announcement takeover. */
  announcement?: boolean;
};

export type SceneBackgroundImage = {
  mediaId: string;
  fit: 'cover' | 'contain';
  /** 0–80 %: darkens (light text) or lightens (dark text) the image so zone content stays readable. */
  dim: number;
};

export type Template = {
  id: string;
  name: string;
  columns: string;
  rows: string;
  zones: { id: string; label: string; col: number; row: number; colSpan: number; rowSpan: number }[];
};

// Playlists -----------------------------------------------------------------------------------------------------------------------
export type PlaylistItem = { id: string; sceneId: string; seconds: number; transition: 'cut' | 'fade' };
export type Playlist = { id: string; name: string; items: PlaylistItem[] };

// Playback rules ------------------------------------------------------------------------------------------------------------------
export type Condition =
  /** days are ISO weekdays, 1 = Monday … 7 = Sunday; a window with from after to runs over midnight. */
  | { kind: 'time'; days: number[]; from: string; to: string }
  | { kind: 'machines'; machines: MachineKey[]; mode: 'any' | 'all' }
  | { kind: 'announcement' }
  | { kind: 'stale' };

export type Target = { type: 'scene' | 'playlist'; id: string };

export type Rule = {
  id: string;
  enabled: boolean;
  condition: Condition;
  target: Target;
  minSeconds: number;
  multiMode: MultiMode;
  alternateSeconds: number;
};

export type Announcement = { sceneId: string | null; text: string | null; until: string | null };

export type Snapshot = { rules: Rule[]; defaultPlaylistId: string; scenes: Scene[]; playlists: Playlist[] };

export type DisplayStatus = 'online' | 'offline' | 'syncing';

export type Display = {
  id: string;
  name: string;
  location: string;
  orientation: Orientation;
  resolution: Resolution;
  outside: boolean;
  status: DisplayStatus;
  lastSeenAt: string;
  syncPercent: number;
  revoked: boolean;
  playerVersion: string;
  cacheGb: number;
  cacheLimitGb: number;
  rules: Rule[];
  defaultPlaylistId: string;
  /** Unpublished changes, one human-readable entry each. */
  pending: string[];
  revision: number;
  publishedAt: string | null;
  published: Snapshot;
  announcement: Announcement | null;
  errors: { at: string; message: string }[];
};

// Media ---------------------------------------------------------------------------------------------------------------------------
export type MediaItem = {
  id: string;
  name: string;
  kind: 'image' | 'video';
  width: number;
  height: number;
  sizeBytes: number;
  format: string;
  checksum: string;
  uploadedBy: string;
  uploadedAt: string;
  /** Data URI (image) or poster data URI (video). */
  src: string;
  status: 'ready' | 'converting';
};

// Local services ------------------------------------------------------------------------------------------------------------------
export type ServiceKind = 'printer_connector' | 'streaming_gateway';
export type LocalService = {
  id: string;
  kind: ServiceKind;
  name: string;
  state: 'online' | 'offline' | 'revoked';
  version: string;
  detail: string;
  rotatesInDays: number;
};

export type PlaybackResult = {
  ruleId: string | 'default' | 'announcement';
  target: Target;
  reason: string;
  activeMachines: MachineKey[];
  multiMode: MultiMode | null;
  alternateSeconds: number;
  /** Set when the winner is an announcement takeover. */
  announcement: Announcement | null;
};
