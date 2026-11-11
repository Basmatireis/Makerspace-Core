import { lazy, Suspense, useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import type {
  SignageAnnouncementWidget,
  SignageAspectRatio,
  SignageBlock,
  SignageCameraWidget,
  SignageImageWidget,
  SignageStatusWidget,
  SignageTextWidget,
} from '../../../api/generated/models';
import { RichText } from './RichTextView';
import {
  blockBoxCss,
  blockInnerCss,
  widgetColorCss,
  cssUrl,
  fontAssetIdsOf,
  registerFontFaces,
  sceneFontCss,
  sceneTextColor,
  type FontFace,
} from './style';
import { frameScale, sceneGridSize, type Orientation } from './aspect';
import { shrinkToFit } from './fit';
import { isPrinting, type RenderData, type RenderMachine, type RenderScene } from './types';
import './render.css';

// The one renderer behind preview frames, thumbnails, the editor canvas and the player. A scene is laid out at exactly
// its grid size in CSS pixels (short side 1080, see sceneGridSize) with absolutely positioned blocks, and ScreenFrame
// scales the whole picture with a transform, so text wraps the same way at every size. Inside a block, widget CSS is
// written in the unit --u (see blockUnit).

// Only scenes with a QR code, a list, a calendar or timelapses need these widgets; the player's initial JavaScript has a budget (its chunk is precached).
const QrCode = lazy(() => import('./QrCode').then((module) => ({ default: module.QrCode })));
const ListWidget = lazy(() => import('./ListWidget').then((module) => ({ default: module.ListWidget })));
const CalendarWidget = lazy(() => import('./CalendarWidget').then((module) => ({ default: module.CalendarWidget })));
const TimelapseWidget = lazy(() => import('./TimelapseWidget').then((module) => ({ default: module.TimelapseWidget })));

/** Announcement titles of banners and cards are 0.8 of the block's text size; the body is 0.6 of the title. */
const ANNOUNCEMENT_TITLE = { full: 1, banner: 0.8, card: 0.8 } as const;
const ANNOUNCEMENT_BODY = 0.6;
const STATE_LABEL: Record<RenderMachine['state'], string> = {
  idle: 'Idle',
  preparing: 'Preparing',
  printing: 'Printing',
  paused: 'Paused',
  finished: 'Finished',
  failed: 'Failed',
  unknown: 'Status unknown',
};
const MIN_ROTATE_SECONDS = 2;

const formatter = (timeZone: string | undefined, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, ...options });
const clockTime = (instant: number | string, timeZone?: string) =>
  formatter(timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));

function MediaImage({ url, fit, label }: { url: string | null; fit: 'contain' | 'cover'; label: string }) {
  if (!url) return <div className="sg-placeholder">{label}</div>;
  return <img className="sg-media" src={url} alt="" style={{ objectFit: fit }} />;
}

/** The image widget, darkened by `dim` percent (so text on top stays readable). */
function ImageWidget({ widget, data }: { widget: SignageImageWidget; data: RenderData }) {
  const url = widget.mediaId ? data.assetUrl(widget.mediaId) : null;
  if (!url || !(widget.dim > 0)) return <MediaImage url={url} fit={widget.fit} label="No image selected" />;
  return (
    <div className="sg-media-box">
      <MediaImage url={url} fit={widget.fit} label="" />
      <div className="sg-dim" style={{ background: `rgba(0, 0, 0, ${Math.min(90, widget.dim) / 100})` }} />
    </div>
  );
}

function Progress({ value }: { value: number }) {
  return (
    <div className="sg-progress" aria-hidden="true">
      <div className="sg-progress__bar" style={{ inlineSize: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

function Remaining({ machine, data }: { machine: RenderMachine; data: RenderData }) {
  if (machine.remainingMinutes === null) return null;
  return <span>ends ~{clockTime(data.now + machine.remainingMinutes * 60_000, data.timeZone)}</span>;
}

/** A camera frame: the player's camera source supplies the picture (`data.cameraView`), otherwise a neutral frame. */
function CameraTile({
  machine,
  widget,
  data,
}: {
  machine: RenderMachine;
  widget: SignageCameraWidget;
  data: RenderData;
}) {
  const progress = widget.showProgress && machine.progressPercent !== null;
  const remaining = widget.showRemaining && machine.remainingMinutes !== null;
  return (
    <div className="sg-camera" role="img" aria-label={`Camera of ${machine.name}`}>
      {data.cameraView?.(machine) ?? (
        <>
          <svg className="sg-camera__icon" viewBox="0 0 32 32" aria-hidden="true">
            <path
              fill="currentColor"
              d="M29 7h-4.6l-1.7-2.6A2 2 0 0 0 21 3.5H11a2 2 0 0 0-1.7.9L7.6 7H3a1 1 0 0 0-1 1v18a1 1 0 0 0 1 1h26a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1Zm-13 16a6 6 0 1 1 6-6 6 6 0 0 1-6 6Z"
            />
          </svg>
          <span className="sg-camera__note">Live camera (shown on the display)</span>
        </>
      )}
      {widget.showLive && <span className="sg-camera__live">Live</span>}
      {(widget.showName || progress || remaining) && (
        <div className="sg-camera__caption">
          {widget.showName && <strong>{machine.name}</strong>}
          {progress && (
            <>
              <Progress value={machine.progressPercent!} />
              <span>{machine.progressPercent} %</span>
            </>
          )}
          {remaining && <Remaining machine={machine} data={data} />}
        </div>
      )}
    </div>
  );
}

function CameraWidget({
  widget,
  data,
  orientation,
}: {
  widget: SignageCameraWidget;
  data: RenderData;
  orientation: Orientation;
}) {
  const candidates =
    widget.source === 'machine'
      ? data.machines.filter((machine) => machine.machineId === widget.machineId)
      : data.machines.filter(
          (machine) =>
            isPrinting(machine) &&
            ((widget.machineIds?.length ?? 0) === 0 || widget.machineIds?.includes(machine.machineId)),
        );
  // A camera shows only while the machine prints, its camera works and live data is available.
  const feeds = data.liveAvailable
    ? candidates.filter((machine) => isPrinting(machine) && !data.unavailableCameras?.has(machine.machineId))
    : [];
  if (feeds.length === 0) {
    if (widget.fallback === 'hide') return null;
    if (widget.fallback === 'image')
      return (
        <MediaImage
          url={widget.fallbackMediaId ? data.assetUrl(widget.fallbackMediaId) : null}
          fit="cover"
          label="No fallback image"
        />
      );
    return (
      <div className="sg-center">
        <strong className="sg-big">Live view unavailable</strong>
        <span>
          {candidates.some(isPrinting)
            ? `${candidates
                .filter(isPrinting)
                .map((machine) => machine.name)
                .join(', ')} printing`
            : 'No machine is printing'}
        </span>
      </div>
    );
  }
  const mode = data.multiMode ?? widget.multi;
  if (feeds.length === 1) return <CameraTile machine={feeds[0]} widget={widget} data={data} />;
  if (mode === 'alternate') {
    const slot = Math.floor(data.now / 1000 / Math.max(MIN_ROTATE_SECONDS, data.alternateSeconds ?? 10)) % feeds.length;
    return (
      <div className="sg-fade" key={feeds[slot].machineId}>
        <CameraTile machine={feeds[slot]} widget={widget} data={data} />
      </div>
    );
  }
  return (
    <div className={`sg-split sg-split--${orientation}`}>
      {feeds.map((machine) => (
        <CameraTile key={machine.machineId} machine={machine} widget={widget} data={data} />
      ))}
    </div>
  );
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
              <span
                className={`sg-status__state${unknown ? ' sg-status__state--unknown' : busy ? ' sg-status__state--busy' : ''}`}
              >
                {unknown ? 'Status unknown' : STATE_LABEL[machine.state]}
              </span>
            </div>
            {!unknown && busy && (widget.showProgress || widget.showRemaining) && (
              <div className="sg-status__detail">
                {widget.showProgress && machine.progressPercent !== null && (
                  <>
                    <Progress value={machine.progressPercent} />
                    <span>{machine.progressPercent} %</span>
                  </>
                )}
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
function AnnouncementWidget({
  widget,
  data,
  textSize,
}: {
  widget: SignageAnnouncementWidget;
  data: RenderData;
  textSize: number;
}) {
  const matching = data.announcements.filter(
    (item) => widget.templateIds.length === 0 || widget.templateIds.includes(item.templateId),
  );
  if (matching.length === 0)
    return widget.whenNone === 'text' && widget.fallbackText.trim() !== '' ? (
      <div className="sg-text">{widget.fallbackText}</div>
    ) : null;
  const shown =
    widget.whenMany === 'stack'
      ? matching
      : widget.whenMany === 'newest'
        ? matching.slice(0, 1)
        : [
            matching[
              Math.floor(data.now / 1000 / Math.max(MIN_ROTATE_SECONDS, widget.rotateSeconds)) % matching.length
            ],
          ];
  const rotating = widget.whenMany === 'rotate' && matching.length > 1;
  const title = textSize * ANNOUNCEMENT_TITLE[widget.style];
  const body = title * ANNOUNCEMENT_BODY;
  return (
    <div className={`sg-ann-list sg-ann-list--${widget.style}`} key={rotating ? shown[0].id : undefined}>
      {shown.map((item) => (
        <div
          key={item.id}
          className={`sg-ann sg-ann--${item.tone} sg-ann--${widget.style}${rotating ? ' sg-fade' : ''}`}
          role="status"
        >
          <strong className="sg-ann__title" style={{ fontSize: `${title}px` }}>
            {item.title}
          </strong>
          {item.body.trim() !== '' &&
            (item.bodyFormat && item.bodyFormat !== 'plain' ? (
              <div className="sg-ann__body sg-ann__body--rich" style={{ fontSize: `${body}px` }}>
                <RichText format={item.bodyFormat} text={item.body} css={item.bodyCss} />
              </div>
            ) : (
              <span className="sg-ann__body" style={{ fontSize: `${body}px` }}>
                {item.body}
              </span>
            ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The text widget: plain text as text nodes, markdown and HTML in a shadow root. With `fit` the text shrinks until the
 * block's content fits (fit.ts); the size is set on the element, so React never resets it. It is measured again when
 * the block, the text or a font changes.
 */
function TextWidget({
  widget,
  textSize,
  layoutKey,
}: {
  widget: SignageTextWidget;
  textSize: number;
  layoutKey: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { fit, text, format, css } = widget;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!fit || !element) return;
    const run = () => shrinkToFit(element, textSize);
    run();
    // Rich text arrives asynchronously (lazy renderer, shadow root): a size change of the text measures again. The
    // search ends on the same size, so it settles after one more call.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(run);
    observer?.observe(element);
    const fonts = element.ownerDocument.fonts as FontFaceSet | undefined;
    fonts?.addEventListener?.('loadingdone', run);
    return () => {
      observer?.disconnect();
      fonts?.removeEventListener?.('loadingdone', run);
      element.style.removeProperty('font-size');
    };
  }, [fit, textSize, text, format, css, layoutKey]);
  if (!format || format === 'plain')
    return (
      <div ref={ref} className="sg-text">
        {text || ' '}
      </div>
    );
  return (
    <div ref={ref} className="sg-text sg-text--rich">
      <RichText format={format} text={text} css={css} className="sg-rich--block" />
    </div>
  );
}

function WidgetView({ block, data }: { block: SignageBlock; data: RenderData }) {
  const { widget } = block;
  switch (widget.type) {
    case 'empty':
      return null;
    case 'image':
      return <ImageWidget widget={widget} data={data} />;
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
      return (
        <div className="sg-fade" key={urls[index]}>
          <MediaImage url={urls[index]} fit="cover" label="" />
        </div>
      );
    }
    case 'text':
      return (
        <TextWidget
          widget={widget}
          textSize={block.style.textSize}
          layoutKey={`${block.w}x${block.h}:${JSON.stringify(block.style)}`}
        />
      );
    case 'qr':
      return (
        <Suspense fallback={null}>
          <QrCode url={widget.url} caption={widget.caption} dark={widget.darkColor} light={widget.lightColor} />
        </Suspense>
      );
    case 'clock':
      return (
        <div className="sg-center sg-center--aligned">
          <strong className={widget.mode === 'date' ? 'sg-clock sg-clock--date' : 'sg-clock'}>
            {widget.mode === 'date'
              ? formatter(data.timeZone, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(
                  new Date(data.now),
                )
              : clockTime(data.now, data.timeZone)}
          </strong>
          {widget.mode === 'datetime' && (
            <span>
              {formatter(data.timeZone, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(data.now))}
            </span>
          )}
        </div>
      );
    case 'camera':
      return <CameraWidget widget={widget} data={data} orientation={block.w >= block.h ? 'landscape' : 'portrait'} />;
    case 'status':
      return <StatusWidget widget={widget} data={data} />;
    case 'announcement':
      return <AnnouncementWidget widget={widget} data={data} textSize={block.style.textSize} />;
    case 'open_days':
    case 'events':
    case 'agenda':
      return (
        <Suspense fallback={null}>
          <ListWidget widget={widget} data={data} />
        </Suspense>
      );
    case 'calendar':
      return (
        <Suspense fallback={null}>
          <CalendarWidget widget={widget} data={data} />
        </Suspense>
      );
    case 'timelapse':
      // Nothing to load without clips: the block shows only its style box.
      if (!data.timelapses?.length) return null;
      return (
        <Suspense fallback={null}>
          <TimelapseWidget widget={widget} data={data} />
        </Suspense>
      );
  }
}

/**
 * A box of the screen's aspect ratio that shows its children on a stage of the screen's grid size (`.sg-stage`,
 * sceneGridSize), scaled with `transform: scale()` to the box. Without `scale` the box is `width` wide (default 100 %)
 * and follows its size with a ResizeObserver; with `scale` (the editor's zoom) the box is the scaled grid size.
 * `onScaleChange` reports the scale in use, e.g. to convert pointer positions into grid units.
 */
export function ScreenFrame({
  aspectRatio,
  width,
  scale,
  onScaleChange,
  className,
  children,
}: {
  aspectRatio: SignageAspectRatio;
  width?: string;
  scale?: number;
  onScaleChange?: (scale: number) => void;
  className?: string;
  children: ReactNode;
}) {
  const grid = sceneGridSize(aspectRatio);
  const frame = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const report = useRef(onScaleChange);
  useLayoutEffect(() => {
    report.current = onScaleChange;
  });
  useLayoutEffect(() => {
    const box = frame.current;
    const target = stage.current;
    if (!box || !target) return;
    let current = -1;
    const apply = (next: number) => {
      if (next === current) return;
      current = next;
      target.style.transform = `scale(${next})`;
      report.current?.(next);
    };
    if (scale !== undefined) {
      apply(scale);
      return;
    }
    // Set directly on the stage: a resize must not re-render the scene.
    const measure = () => apply(frameScale(box.clientWidth, box.clientHeight, grid.width, grid.height));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [scale, grid.width, grid.height]);
  const style: CSSProperties =
    scale !== undefined
      ? { inlineSize: `${grid.width * scale}px`, blockSize: `${grid.height * scale}px` }
      : { aspectRatio: `${aspectRatio.width} / ${aspectRatio.height}`, ...(width ? { inlineSize: width } : {}) };
  return (
    <div ref={frame} className={`sg-frame${className ? ` ${className}` : ''}`} style={style}>
      <div ref={stage} className="sg-stage" style={{ width: `${grid.width}px`, height: `${grid.height}px` }}>
        {children}
      </div>
    </div>
  );
}

/** Colour, optionally layered under an image and a dimming veil (black for light text, white for dark text). */
function sceneBackground(scene: RenderScene, data: RenderData): string {
  const url = scene.backgroundAssetId ? data.assetUrl(scene.backgroundAssetId) : null;
  if (!url) return scene.backgroundColor;
  const veil =
    scene.theme === 'dark'
      ? `rgba(0, 0, 0, ${scene.backgroundDim / 100})`
      : `rgba(255, 255, 255, ${scene.backgroundDim / 100})`;
  return `linear-gradient(${veil}, ${veil}), ${cssUrl(url)} center / ${scene.backgroundFit} no-repeat, ${scene.backgroundColor}`;
}

export type SceneRendererProps = {
  scene: RenderScene | null;
  data: RenderData;
  /**
   * Editor: draw hidden blocks faded (class `sg-block--hidden`) instead of leaving them out like displays do.
   */
  showHidden?: boolean;
  /** Editor: blocks that get the class `sg-block--selected` (styled by the editor). */
  selectedBlockIds?: readonly string[];
};

/** Font assets of the scene and its blocks, named by their asset name (the @font-face family). */
function sceneFonts(scene: RenderScene, data: RenderData, blocks: readonly SignageBlock[]): FontFace[] {
  const fonts = new Map<string, FontFace>();
  const ids = [
    ...(scene.fontFamily === 'custom' && scene.fontAssetId ? [scene.fontAssetId] : []),
    ...blocks.flatMap(fontAssetIdsOf),
  ];
  for (const id of ids) {
    const family = data.assetName?.(id);
    const url = data.assetUrl(id);
    if (family && url) fonts.set(id, { family, url });
  }
  return [...fonts.values()];
}

/**
 * Renders a scene at its grid size (`.sg-scene`, W × H CSS pixels) with its blocks absolutely positioned in grid
 * pixels, later blocks on top. Every block is `<div class="sg-block sg-block--{widget type}" data-block-id>` with the
 * box style, holding `.sg-block__in` (padding, vertical alignment) with the widget. Put it in a ScreenFrame to scale it.
 * The editor finds blocks with `[data-block-id]` (event delegation) and overflow with `overflowingBlockIds` (fit.ts).
 */
export function SceneRenderer({ scene, data, showHidden = false, selectedBlockIds }: SceneRendererProps) {
  const blocks = scene ? scene.blocks.filter((block) => showHidden || !block.hidden) : [];
  // The fonts as a string, so the effect only runs when a family or URL changes (the data object is new every second).
  const fontKey = JSON.stringify(scene ? sceneFonts(scene, data, blocks) : []);
  useEffect(() => {
    registerFontFaces(JSON.parse(fontKey) as FontFace[]);
  }, [fontKey]);
  if (!scene) return <div className="sg-scene sg-scene--empty" />;
  const grid = sceneGridSize(scene.aspectRatio);
  const textColor = sceneTextColor(scene.theme);
  const style: CSSProperties = {
    width: `${grid.width}px`,
    height: `${grid.height}px`,
    background: sceneBackground(scene, data),
    fontFamily: sceneFontCss(
      scene,
      scene.fontFamily === 'custom' && scene.fontAssetId ? (data.assetName?.(scene.fontAssetId) ?? null) : null,
    ),
  };
  return (
    <div className={`sg-scene sg-scene--${scene.theme}`} style={style}>
      {blocks.map((block) => {
        const fontId = block.style.fontFamily === 'custom' ? block.style.fontAssetId : null;
        const box = blockBoxCss(block, {
          sceneTextColor: textColor,
          fontName: fontId ? (data.assetName?.(fontId) ?? null) : null,
          backgroundUrl: block.style.backgroundAssetId ? data.assetUrl(block.style.backgroundAssetId) : null,
          hidden: block.hidden,
        });
        const className = [
          'sg-block',
          `sg-block--${block.widget.type}`,
          block.hidden ? 'sg-block--hidden' : '',
          selectedBlockIds?.includes(block.id) ? 'sg-block--selected' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <div
            key={block.id}
            className={className}
            style={{ ...box, ...widgetColorCss(block.widget) }}
            data-block-id={block.id}
          >
            <div className="sg-block__in" style={blockInnerCss(block.style)}>
              <WidgetView block={block} data={data} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
