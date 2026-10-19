import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { MACHINE_NAMES, printingMachines } from '../engine';
import { cameraFrames, eventsSeed, machineLive, openDaysSeed } from '../mockData';
import { formatClock, sampleRendered } from '../helpers';
import { useSignage } from '../SignageContext';
import { templateById } from '../templates';
import type { MachineKey, MediaItem, MultiMode, Orientation, RenderedAnnouncement, Scene, Sim, Widget } from '../types';
import { qrModules } from './qr';

// The one renderer behind preview frames, thumbnails, the editor canvas and the fullscreen player.
// It is plain markup and CSS (no Carbon components): the real player is a separate small app. Sizes use the
// container-relative unit --u (1u = 10.8 px on a 1080 px wide design), so a scene looks the same at any scale.

export type PlaybackContext = { activeMachines: MachineKey[]; multiMode: MultiMode | null; alternateSeconds: number };

type RenderContext = { sim: Sim; now: number; media: Map<string, MediaItem>; playback: PlaybackContext; orientation: Orientation; announcements: RenderedAnnouncement[] };

const TEXT_SIZE = { s: 3, m: 4.6, l: 7, xl: 10 } as const;

function MediaImage({ item, fit, label }: { item: MediaItem | undefined; fit: 'contain' | 'cover'; label: string }) {
  if (!item) return <div className="sg-placeholder">{label}</div>;
  return <img className="sg-media" src={item.src} alt="" style={{ objectFit: fit }} />;
}

function QrCode({ url, caption }: { url: string; caption: string }) {
  const modules = useMemo(() => qrModules(url), [url]);
  return (
    <div className="sg-qr">
      <svg viewBox={`-1 -1 ${modules.length + 2} ${modules.length + 2}`} className="sg-qr__code" role="img" aria-label={`QR code for ${url}`} shapeRendering="crispEdges">
        <rect x="-1" y="-1" width={modules.length + 2} height={modules.length + 2} fill="#fff" />
        {modules.flatMap((row, y) => row.map((on, x) => on ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="#161616" /> : null))}
      </svg>
      <div className="sg-qr__text"><strong>{caption}</strong><span>{url.replace(/^https?:\/\//, '')}</span></div>
    </div>
  );
}

function Progress({ value }: { value: number }) {
  return <div className="sg-progress" aria-hidden="true"><div className="sg-progress__bar" style={{ inlineSize: `${value}%` }} /></div>;
}

function CameraTile({ machine, widget, ctx }: { machine: MachineKey; widget: Extract<Widget, { type: 'camera' }>; ctx: RenderContext }) {
  const live = machineLive[machine];
  const frames = cameraFrames[machine];
  return (
    <div className="sg-feed">
      <img className="sg-media sg-feed__image" src={frames[Math.floor(ctx.now / 1500) % frames.length]} alt="" />
      <div className="sg-feed__scan" aria-hidden="true" />
      <span className="sg-feed__live"><span className="sg-feed__dot" />LIVE</span>
      <div className="sg-feed__caption">
        <strong>{MACHINE_NAMES[machine]}</strong>
        {widget.showProgress && <><Progress value={live.progress} /><span>{live.progress} %</span></>}
        {widget.showRemaining && <span>ends ~{live.endsAt}</span>}
      </div>
    </div>
  );
}

function CameraWidget({ widget, ctx }: { widget: Extract<Widget, { type: 'camera' }>; ctx: RenderContext }) {
  const candidates = widget.source === 'machine' ? [widget.machineId] : ctx.playback.activeMachines;
  // A camera only streams while the machine prints, its camera works and Core is reachable.
  const feeds = candidates.filter((machine) => ctx.sim[machine] === 'printing' && ctx.sim.coreReachable);
  if (feeds.length === 0) {
    if (widget.fallback === 'hide') return null;
    if (widget.fallback === 'image') return <MediaImage item={widget.fallbackMediaId ? ctx.media.get(widget.fallbackMediaId) : undefined} fit="cover" label="No fallback image" />;
    return (
      <div className="sg-center">
        <strong className="sg-big">Live view unavailable</strong>
        <span>{candidates.length > 0 ? `${candidates.map((machine) => MACHINE_NAMES[machine]).join(', ')} printing` : 'No machine is printing'}</span>
      </div>
    );
  }
  const mode = ctx.playback.multiMode ?? widget.multi;
  if (feeds.length === 1) return <CameraTile machine={feeds[0]} widget={widget} ctx={ctx} />;
  if (mode === 'alternate') {
    const slot = Math.floor(ctx.now / 1000 / Math.max(2, ctx.playback.alternateSeconds)) % feeds.length;
    return <div className="sg-fade" key={feeds[slot]}><CameraTile machine={feeds[slot]} widget={widget} ctx={ctx} /></div>;
  }
  return <div className={`sg-split sg-split--${ctx.orientation}`}>{feeds.map((machine) => <CameraTile key={machine} machine={machine} widget={widget} ctx={ctx} />)}</div>;
}

function StatusWidget({ widget, ctx }: { widget: Extract<Widget, { type: 'status' }>; ctx: RenderContext }) {
  return (
    <ul className="sg-status">
      {widget.machineIds.map((machine) => {
        const live = machineLive[machine];
        const state = ctx.sim[machine];
        const unknown = !ctx.sim.coreReachable;
        return (
          <li key={machine} className="sg-status__row">
            <div className="sg-status__head">
              <strong>{MACHINE_NAMES[machine]}</strong>
              <span className={`sg-status__state${unknown ? ' sg-status__state--unknown' : state !== 'idle' ? ' sg-status__state--busy' : ''}`}>{unknown ? 'Status unknown' : state === 'idle' ? 'Idle' : 'Printing'}</span>
            </div>
            {!unknown && state !== 'idle' && (widget.showProgress || widget.showRemaining) && (
              <div className="sg-status__detail">
                {widget.showProgress && <><Progress value={live.progress} /><span>{live.progress} %</span></>}
                {widget.showRemaining && <span>ends ~{live.endsAt}</span>}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Announcements matching the widget's filter, shown per the "several active" setting; nothing active falls back as configured. */
function AnnouncementWidget({ widget, ctx }: { widget: Extract<Widget, { type: 'announcement' }>; ctx: RenderContext }) {
  const matching = ctx.announcements.filter((item) => widget.templateIds.length === 0 || widget.templateIds.includes(item.templateId));
  if (matching.length === 0) return widget.whenNone === 'text' && widget.fallbackText.trim() !== '' ? <div className="sg-text" style={{ fontSize: `calc(var(--u) * ${TEXT_SIZE[widget.size]})` }}>{widget.fallbackText}</div> : null;
  const shown = widget.whenMany === 'stack' ? matching
    : widget.whenMany === 'newest' ? matching.slice(0, 1)
      : [matching[Math.floor(ctx.now / 1000 / Math.max(2, widget.rotateSeconds)) % matching.length]];
  const rotating = widget.whenMany === 'rotate' && matching.length > 1;
  const unit = TEXT_SIZE[widget.size] * (widget.style === 'full' ? 1 : 0.8);
  return (
    <div className={`sg-ann-list sg-ann-list--${widget.style}`} key={rotating ? shown[0].id : undefined}>
      {shown.map((item) => (
        <div key={item.id} className={`sg-ann sg-ann--${item.tone} sg-ann--${widget.style}${rotating ? ' sg-fade' : ''}`} role="status">
          <strong className="sg-ann__title" style={{ fontSize: `calc(var(--u) * ${unit})` }}>{item.title}</strong>
          {item.body.trim() !== '' && <span className="sg-ann__body" style={{ fontSize: `calc(var(--u) * ${unit * 0.6})` }}>{item.body}</span>}
        </div>
      ))}
    </div>
  );
}

function WidgetView({ widget, ctx }: { widget: Widget; ctx: RenderContext }) {
  switch (widget.type) {
    case 'empty': return null;
    case 'image': return <MediaImage item={widget.mediaId ? ctx.media.get(widget.mediaId) : undefined} fit={widget.fit} label="No image selected" />;
    case 'video': {
      const item = widget.mediaId ? ctx.media.get(widget.mediaId) : undefined;
      return <><MediaImage item={item} fit={widget.fit} label="No video selected" />{item && <span className="sg-video-badge">Video · muted loop</span>}</>;
    }
    case 'slideshow': {
      const items = widget.mediaIds.map((id) => ctx.media.get(id)).filter((item): item is MediaItem => Boolean(item));
      if (items.length === 0) return <div className="sg-placeholder">No slides</div>;
      const index = Math.floor(ctx.now / 1000 / Math.max(1, widget.seconds)) % items.length;
      return <div className="sg-fade" key={items[index].id}><MediaImage item={items[index]} fit="cover" label="" /></div>;
    }
    case 'text': return <div className="sg-text" style={{ fontSize: `calc(var(--u) * ${TEXT_SIZE[widget.size]})`, textAlign: widget.align }}>{widget.text || ' '}</div>;
    case 'qr': return <QrCode url={widget.url} caption={widget.caption} />;
    case 'clock': {
      const date = new Date(ctx.now);
      return (
        <div className="sg-center">
          <strong className="sg-clock">{formatClock(date)}</strong>
          {widget.mode === 'datetime' && <span>{date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</span>}
        </div>
      );
    }
    case 'camera': return <CameraWidget widget={widget} ctx={ctx} />;
    case 'status': return <StatusWidget widget={widget} ctx={ctx} />;
    case 'announcement': return <AnnouncementWidget widget={widget} ctx={ctx} />;
    case 'open_days':
      return <div className="sg-list"><strong className="sg-list__title">Next open days</strong>{openDaysSeed.slice(0, widget.count).map((entry) => <div key={entry.date} className="sg-list__row"><span>{entry.date}</span><span>{entry.time}</span></div>)}</div>;
    case 'events':
      return <div className="sg-list"><strong className="sg-list__title">Upcoming events</strong>{eventsSeed.slice(0, widget.count).map((entry) => <div key={entry.title} className="sg-list__row"><span>{entry.title}</span><span>{entry.when}</span></div>)}</div>;
  }
}

/** Aspect-ratio box that also provides the container for the relative units. */
export function ScreenFrame({ orientation, resolution, width, className, children }: { orientation: Orientation; resolution?: { w: number; h: number }; width?: string; className?: string; children: ReactNode }) {
  const size = resolution ?? (orientation === 'portrait' ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 });
  const style: CSSProperties = { aspectRatio: `${size.w} / ${size.h}`, ...(width ? { inlineSize: width } : {}) };
  return <div className={`sg-frame sg-frame--${orientation}${className ? ` ${className}` : ''}`} style={style}>{children}</div>;
}

export type SceneRendererProps = {
  scene: Scene | null;
  /** Orientation of the screen the scene is shown on (sets the unit scale). Defaults to the scene's own. */
  screenOrientation?: Orientation;
  sim: Sim;
  now: number;
  media: MediaItem[];
  playback?: PlaybackContext;
  /** Active announcements for the screen, already rendered (see `renderedFor`). */
  announcements?: RenderedAnnouncement[];
  selectedZone?: string | null;
  onSelectZone?: (zoneId: string) => void;
};

/** Colour, optionally layered under an image and a dimming veil (black for light text, white for dark text). */
function sceneBackground(scene: Scene, media: Map<string, MediaItem>): string {
  const image = scene.backgroundImage;
  const item = image ? media.get(image.mediaId) : undefined;
  if (!image || !item) return scene.background;
  const veil = scene.theme === 'dark' ? `rgba(0, 0, 0, ${image.dim / 100})` : `rgba(255, 255, 255, ${image.dim / 100})`;
  return `linear-gradient(${veil}, ${veil}), url("${item.src}") center / ${image.fit} no-repeat, ${scene.background}`;
}

export function SceneRenderer({ scene, screenOrientation, sim, now, media, playback, announcements, selectedZone, onSelectZone }: SceneRendererProps) {
  const lookup = useMemo(() => new Map(media.map((item) => [item.id, item])), [media]);
  if (!scene) return <div className="sg-scene sg-scene--empty" />;
  const orientation = screenOrientation ?? scene.orientation;
  const template = templateById(scene.templateId);
  const ctx: RenderContext = { sim, now, media: lookup, orientation, announcements: announcements ?? [], playback: playback ?? { activeMachines: printingMachines(sim), multiMode: null, alternateSeconds: 10 } };
  const style = { '--u': orientation === 'portrait' ? '1cqw' : '0.5625cqw', background: sceneBackground(scene, lookup), gridTemplateColumns: template.columns, gridTemplateRows: template.rows } as CSSProperties;
  return (
    <div className={`sg-scene sg-scene--${scene.theme}`} style={style}>
      {template.zones.map((zone) => {
        const widget = scene.zones[zone.id] ?? { type: 'empty' as const };
        return (
          <div key={zone.id} className={`sg-zone sg-zone--${widget.type}${selectedZone === zone.id ? ' sg-zone--selected' : ''}`} style={{ gridColumn: `${zone.col} / span ${zone.colSpan}`, gridRow: `${zone.row} / span ${zone.rowSpan}` }}>
            <WidgetView widget={widget} ctx={ctx} />
            {onSelectZone && (
              <button type="button" className="sg-zone__select" aria-pressed={selectedZone === zone.id} aria-label={`Select zone ${zone.label}`} onClick={() => onSelectZone(zone.id)}>
                <span className="sg-zone__label">{zone.label}</span>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Small static rendering of a scene for tiles, tables and playlist rows. */
export function SceneThumbnail({ scene, media, className }: { scene: Scene; media: MediaItem[]; className?: string }) {
  const { announcementTemplates } = useSignage();
  const announcements = useMemo(() => sampleRendered(announcementTemplates, new Date(THUMB_NOW)), [announcementTemplates]);
  return (
    <ScreenFrame orientation={scene.orientation} className={`sg-thumb${className ? ` ${className}` : ''}`}>
      <SceneRenderer scene={scene} sim={THUMB_SIM} now={THUMB_NOW} media={media} announcements={announcements} />
    </ScreenFrame>
  );
}
const THUMB_NOW = 1_800_000_000_000;
const THUMB_SIM: Sim = { h2d: 'idle', x1c: 'idle', coreReachable: true };
