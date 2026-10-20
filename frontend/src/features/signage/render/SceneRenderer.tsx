import { useMemo, type CSSProperties, type ReactNode } from 'react';
import type { SignageAnnouncementWidget, SignageCameraWidget, SignageStatusWidget } from '../../../api/generated/models';
import { layoutById } from '../layouts';
import { qrModules } from './qr';
import { isPrinting, type RenderData, type RenderMachine, type RenderScene, type SignageOrientation } from './types';
import './render.css';

// The one renderer behind preview frames, thumbnails, the editor canvas and (later) the player.
// Sizes use the container-relative unit --u (1u = 1 % of the design width), so a scene looks the same at any scale.

const TEXT_SIZE = { s: 3, m: 4.6, l: 7, xl: 10 } as const;
const STATE_LABEL: Record<RenderMachine['state'], string> = { idle: 'Idle', preparing: 'Preparing', printing: 'Printing', paused: 'Paused', finished: 'Finished', failed: 'Failed', unknown: 'Status unknown' };
const MIN_ROTATE_SECONDS = 2;

const formatter = (timeZone: string | undefined, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone, ...options });
const clockTime = (instant: number | string, timeZone?: string) => formatter(timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
const shortDate = (instant: string, timeZone?: string) => formatter(timeZone, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(instant));

function MediaImage({ url, fit, label }: { url: string | null; fit: 'contain' | 'cover'; label: string }) {
  if (!url) return <div className="sg-placeholder">{label}</div>;
  return <img className="sg-media" src={url} alt="" style={{ objectFit: fit }} />;
}

function QrCode({ url, caption }: { url: string; caption: string }) {
  const modules = useMemo(() => qrModules(url), [url]);
  return (
    <div className="sg-qr">
      {modules ? <svg viewBox={`-2 -2 ${modules.length + 4} ${modules.length + 4}`} className="sg-qr__code" role="img" aria-label={`QR code for ${url}`} shapeRendering="crispEdges">
        <rect x="-2" y="-2" width={modules.length + 4} height={modules.length + 4} fill="#fff" />
        {modules.flatMap((row, y) => row.map((on, x) => on ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="#161616" /> : null))}
      </svg> : <div className="sg-placeholder">Link too long for a QR code</div>}
      <div className="sg-qr__text"><strong>{caption}</strong><span>{url.replace(/^https?:\/\//, '')}</span></div>
    </div>
  );
}

function Progress({ value }: { value: number }) {
  return <div className="sg-progress" aria-hidden="true"><div className="sg-progress__bar" style={{ inlineSize: `${Math.min(100, Math.max(0, value))}%` }} /></div>;
}

function Remaining({ machine, data }: { machine: RenderMachine; data: RenderData }) {
  if (machine.remainingMinutes === null) return null;
  return <span>ends ~{clockTime(data.now + machine.remainingMinutes * 60_000, data.timeZone)}</span>;
}

/** A camera frame: the player's camera source supplies the picture (`data.cameraView`), otherwise a neutral frame. */
function CameraTile({ machine, widget, data }: { machine: RenderMachine; widget: SignageCameraWidget; data: RenderData }) {
  return (
    <div className="sg-camera" role="img" aria-label={`Camera of ${machine.name}`}>
      {data.cameraView?.(machine) ?? <><svg className="sg-camera__icon" viewBox="0 0 32 32" aria-hidden="true"><path fill="currentColor" d="M29 7h-4.6l-1.7-2.6A2 2 0 0 0 21 3.5H11a2 2 0 0 0-1.7.9L7.6 7H3a1 1 0 0 0-1 1v18a1 1 0 0 0 1 1h26a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1Zm-13 16a6 6 0 1 1 6-6 6 6 0 0 1-6 6Z" /></svg><span className="sg-camera__note">Live camera (shown on the display)</span></>}
      <div className="sg-camera__caption">
        <strong>{machine.name}</strong>
        {widget.showProgress && machine.progressPercent !== null && <><Progress value={machine.progressPercent} /><span>{machine.progressPercent} %</span></>}
        {widget.showRemaining && <Remaining machine={machine} data={data} />}
      </div>
    </div>
  );
}

function CameraWidget({ widget, data, orientation }: { widget: SignageCameraWidget; data: RenderData; orientation: SignageOrientation }) {
  const candidates = widget.source === 'machine'
    ? data.machines.filter((machine) => machine.machineId === widget.machineId)
    : data.machines.filter(isPrinting);
  // A camera shows only while the machine prints, its camera works and live data is available.
  const feeds = data.liveAvailable ? candidates.filter((machine) => isPrinting(machine) && !data.unavailableCameras?.has(machine.machineId)) : [];
  if (feeds.length === 0) {
    if (widget.fallback === 'hide') return null;
    if (widget.fallback === 'image') return <MediaImage url={widget.fallbackMediaId ? data.assetUrl(widget.fallbackMediaId) : null} fit="cover" label="No fallback image" />;
    return (
      <div className="sg-center">
        <strong className="sg-big">Live view unavailable</strong>
        <span>{candidates.some(isPrinting) ? `${candidates.filter(isPrinting).map((machine) => machine.name).join(', ')} printing` : 'No machine is printing'}</span>
      </div>
    );
  }
  const mode = data.multiMode ?? widget.multi;
  if (feeds.length === 1) return <CameraTile machine={feeds[0]} widget={widget} data={data} />;
  if (mode === 'alternate') {
    const slot = Math.floor(data.now / 1000 / Math.max(MIN_ROTATE_SECONDS, data.alternateSeconds ?? 10)) % feeds.length;
    return <div className="sg-fade" key={feeds[slot].machineId}><CameraTile machine={feeds[slot]} widget={widget} data={data} /></div>;
  }
  return <div className={`sg-split sg-split--${orientation}`}>{feeds.map((machine) => <CameraTile key={machine.machineId} machine={machine} widget={widget} data={data} />)}</div>;
}

function StatusWidget({ widget, data }: { widget: SignageStatusWidget; data: RenderData }) {
  return (
    <ul className="sg-status">
      {widget.machineIds.map((machineId) => {
        const machine = data.machines.find((item) => item.machineId === machineId);
        const unknown = !data.liveAvailable || !machine || machine.stale || machine.state === 'unknown';
        const busy = Boolean(machine) && isPrinting(machine!);
        return (
          <li key={machineId} className="sg-status__row">
            <div className="sg-status__head">
              <strong>{machine?.name ?? 'Machine'}</strong>
              <span className={`sg-status__state${unknown ? ' sg-status__state--unknown' : busy ? ' sg-status__state--busy' : ''}`}>{unknown ? 'Status unknown' : STATE_LABEL[machine.state]}</span>
            </div>
            {!unknown && busy && (widget.showProgress || widget.showRemaining) && (
              <div className="sg-status__detail">
                {widget.showProgress && machine.progressPercent !== null && <><Progress value={machine.progressPercent} /><span>{machine.progressPercent} %</span></>}
                {widget.showRemaining && <Remaining machine={machine} data={data} />}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Announcements matching the widget's filter, shown per the "several active" setting; nothing active falls back as configured. */
function AnnouncementWidget({ widget, data }: { widget: SignageAnnouncementWidget; data: RenderData }) {
  const matching = data.announcements.filter((item) => widget.templateIds.length === 0 || widget.templateIds.includes(item.templateId));
  if (matching.length === 0) return widget.whenNone === 'text' && widget.fallbackText.trim() !== '' ? <div className="sg-text" style={{ fontSize: `calc(var(--u) * ${TEXT_SIZE[widget.size]})` }}>{widget.fallbackText}</div> : null;
  const shown = widget.whenMany === 'stack' ? matching
    : widget.whenMany === 'newest' ? matching.slice(0, 1)
      : [matching[Math.floor(data.now / 1000 / Math.max(MIN_ROTATE_SECONDS, widget.rotateSeconds)) % matching.length]];
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

function WidgetView({ widget, data, orientation }: { widget: RenderScene['zones'][string]; data: RenderData; orientation: SignageOrientation }) {
  switch (widget.type) {
    case 'empty': return null;
    case 'image': return <MediaImage url={widget.mediaId ? data.assetUrl(widget.mediaId) : null} fit={widget.fit} label="No image selected" />;
    case 'video': {
      const url = widget.mediaId ? data.assetUrl(widget.mediaId) : null;
      if (!url) return <div className="sg-placeholder">No video selected</div>;
      if (data.still) return <div className="sg-placeholder">Video</div>;
      return <video className="sg-media" src={url} style={{ objectFit: widget.fit }} muted loop autoPlay playsInline />;
    }
    case 'slideshow': {
      const urls = widget.mediaIds.map((id) => data.assetUrl(id)).filter((url): url is string => Boolean(url));
      if (urls.length === 0) return <div className="sg-placeholder">No slides</div>;
      const index = data.still ? 0 : Math.floor(data.now / 1000 / Math.max(1, widget.seconds)) % urls.length;
      return <div className="sg-fade" key={urls[index]}><MediaImage url={urls[index]} fit="cover" label="" /></div>;
    }
    case 'text': return <div className="sg-text" style={{ fontSize: `calc(var(--u) * ${TEXT_SIZE[widget.size]})`, textAlign: widget.align }}>{widget.text || ' '}</div>;
    case 'qr': return <QrCode url={widget.url} caption={widget.caption} />;
    case 'clock':
      return (
        <div className="sg-center">
          <strong className="sg-clock">{clockTime(data.now, data.timeZone)}</strong>
          {widget.mode === 'datetime' && <span>{formatter(data.timeZone, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(data.now))}</span>}
        </div>
      );
    case 'camera': return <CameraWidget widget={widget} data={data} orientation={orientation} />;
    case 'status': return <StatusWidget widget={widget} data={data} />;
    case 'announcement': return <AnnouncementWidget widget={widget} data={data} />;
    case 'open_days':
      return (
        <div className="sg-list">
          <strong className="sg-list__title">Next open days</strong>
          {data.openDays.length === 0 && <span className="sg-list__empty">No open days planned</span>}
          {data.openDays.slice(0, widget.count).map((entry) => <div key={entry.startsAt} className="sg-list__row"><span>{shortDate(entry.startsAt, data.timeZone)}</span><span>{clockTime(entry.startsAt, data.timeZone)}–{clockTime(entry.endsAt, data.timeZone)}</span></div>)}
        </div>
      );
    case 'events':
      return (
        <div className="sg-list">
          <strong className="sg-list__title">Upcoming events</strong>
          {data.events.length === 0 && <span className="sg-list__empty">No events planned</span>}
          {data.events.slice(0, widget.count).map((entry) => <div key={`${entry.startsAt}-${entry.title}`} className="sg-list__row"><span>{entry.title}</span><span>{shortDate(entry.startsAt, data.timeZone)} {clockTime(entry.startsAt, data.timeZone)}</span></div>)}
        </div>
      );
  }
}

/** Aspect-ratio box that also provides the container for the relative units. */
export function ScreenFrame({ orientation, resolution, width, className, children }: { orientation: SignageOrientation; resolution?: { width: number; height: number }; width?: string; className?: string; children: ReactNode }) {
  const size = resolution ?? (orientation === 'portrait' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 });
  const style: CSSProperties = { aspectRatio: `${size.width} / ${size.height}`, ...(width ? { inlineSize: width } : {}) };
  return <div className={`sg-frame sg-frame--${orientation}${className ? ` ${className}` : ''}`} style={style}>{children}</div>;
}

/** Colour, optionally layered under an image and a dimming veil (black for light text, white for dark text). */
function sceneBackground(scene: RenderScene, data: RenderData): string {
  const url = scene.backgroundAssetId ? data.assetUrl(scene.backgroundAssetId) : null;
  if (!url) return scene.backgroundColor;
  const veil = scene.theme === 'dark' ? `rgba(0, 0, 0, ${scene.backgroundDim / 100})` : `rgba(255, 255, 255, ${scene.backgroundDim / 100})`;
  return `linear-gradient(${veil}, ${veil}), url("${url.replace(/["\\\n]/g, encodeURIComponent)}") center / ${scene.backgroundFit} no-repeat, ${scene.backgroundColor}`;
}

export type SceneRendererProps = {
  scene: RenderScene | null;
  data: RenderData;
  /** Orientation of the screen the scene is shown on (sets the unit scale). Defaults to the scene's own. */
  screenOrientation?: SignageOrientation;
  selectedZone?: string | null;
  onSelectZone?: (zoneId: string) => void;
};

export function SceneRenderer({ scene, data, screenOrientation, selectedZone, onSelectZone }: SceneRendererProps) {
  if (!scene) return <div className="sg-scene sg-scene--empty" />;
  const orientation = screenOrientation ?? scene.orientation;
  const layout = layoutById(scene.layoutId);
  const style = { '--u': orientation === 'portrait' ? '1cqw' : '0.5625cqw', background: sceneBackground(scene, data), gridTemplateColumns: layout.columns, gridTemplateRows: layout.rows } as CSSProperties;
  return (
    <div className={`sg-scene sg-scene--${scene.theme}`} style={style}>
      {layout.zones.map((zone) => {
        const widget = scene.zones[zone.id] ?? { type: 'empty' as const };
        return (
          <div key={zone.id} className={`sg-zone sg-zone--${widget.type}${selectedZone === zone.id ? ' sg-zone--selected' : ''}`} style={{ gridColumn: `${zone.col} / span ${zone.colSpan}`, gridRow: `${zone.row} / span ${zone.rowSpan}` }}>
            <WidgetView widget={widget} data={data} orientation={orientation} />
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
