import { InlineLoading } from '@carbon/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PdfTemplateBox } from '../../../api/generated/models';
import { useLatestCallback } from '../../../app/useLatestCallback';
import { clampZoom, type Zoom } from '../../signage/editor/zoom';
import { find, layerElementId, type TemplateDocument, type TemplateNode, type ToolType } from '../model';
import { handlesFor } from '../ops';
import { frameGeometry } from '../overlayModel';
import { PX_PER_MM } from '../renderPreview';
import type { TimedPreview } from '../queries';
import { drawnRect, usePreviewInteraction, type DragState, type DrawResult } from '../usePreviewInteraction';
import type { ShownPreview } from '../usePreviewDocument';
import { PdfPageCanvas } from './PdfPageCanvas';

export interface PreviewCanvasProps {
  shown: ShownPreview<TimedPreview> | null;
  doc: TemplateDocument;
  selectedId: string | null;
  hoverId: string | null;
  tool: ToolType | null;
  zoom: Zoom;
  onZoom: (zoom: Zoom) => void;
  /** The scale in effect, also while fitting. */
  onScale: (scale: number) => void;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onGeometry: (id: string, patch: Record<string, number>) => void;
  onDraw: (result: DrawResult) => void;
  /** Only look: no overlay for hover, selection, move or drawing, and the region is a plain scrollable one. */
  readOnly?: boolean;
}

const MARGIN_PX = 24;
const LABEL_PX = 18;

/** The ids whose boxes a selection or hover outlines: the node, or the elements of a layer. */
function outlined(doc: TemplateDocument, id: string | null): Set<string> {
  if (!id || id === 'page') return new Set();
  const node = find(doc, id)?.node;
  if (!node) return new Set();
  return new Set(node.type === 'layer' ? node.elements.map((e) => e.id) : [id]);
}

/**
 * The preview: the server-rendered PDF drawn by pdf.js, with an overlay for hover, selection, move, resize and drawing.
 * Carbon has no canvas or direct-manipulation component, so the overlay is handwritten.
 */
export function PreviewCanvas(props: PreviewCanvasProps) {
  const { shown, doc, selectedId, hoverId, tool, zoom, onZoom, onScale } = props;
  const host = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(0.5);
  const boxes = shown?.preview.boxes;
  const pages = shown?.preview.pages;
  const firstWidth = pages?.[0]?.width;
  const firstHeight = pages?.[0]?.height;
  const scale = zoom === 'fit' ? fit : zoom;

  // Fit: the largest scale (at most 100 %) that shows one whole page.
  useLayoutEffect(() => {
    const element = host.current;
    if (!element || !firstWidth || !firstHeight) return;
    const measure = () => {
      const w = element.clientWidth - 2 * MARGIN_PX;
      const h = element.clientHeight - 2 * MARGIN_PX - LABEL_PX;
      if (w <= 0 || h <= 0) return;
      setFit(Math.max(0.05, Math.min(1, w / (firstWidth * PX_PER_MM), h / (firstHeight * PX_PER_MM))));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [firstWidth, firstHeight]);

  useEffect(() => onScale(scale), [scale, onScale]);

  // Zooming keeps the point under the pointer (or the centre of the view) where it is.
  const anchor = useRef<{ x: number; y: number } | null>(null);
  const previous = useRef(scale);
  useLayoutEffect(() => {
    const element = host.current;
    const old = previous.current;
    previous.current = scale;
    if (!element || old === scale) return;
    const at = anchor.current ?? { x: element.clientWidth / 2, y: element.clientHeight / 2 };
    anchor.current = null;
    const ax = (element.scrollLeft + at.x) / old;
    const ay = (element.scrollTop + at.y) / old;
    element.scrollLeft = ax * scale - at.x;
    element.scrollTop = ay * scale - at.y;
  }, [scale]);

  const wheel = useLatestCallback((event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const rect = host.current?.getBoundingClientRect();
    if (rect) anchor.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    onZoom(clampZoom(scale * Math.exp(-event.deltaY * 0.01)));
  });
  useEffect(() => {
    const element = host.current;
    element?.addEventListener('wheel', wheel, { passive: false });
    return () => element?.removeEventListener('wheel', wheel);
  }, [wheel]);

  const interaction = usePreviewInteraction({
    doc,
    boxes: boxes ?? [],
    pages,
    scale,
    selectedId,
    tool,
    onSelect: props.onSelect,
    onHover: props.onHover,
    onGeometry: props.onGeometry,
    onDraw: props.onDraw,
  });
  const { drag, drawing } = interaction;

  const selectedIds = useMemo(() => outlined(doc, selectedId), [doc, selectedId]);
  const hoverIds = useMemo(() => outlined(doc, hoverId), [doc, hoverId]);
  // A selection made elsewhere (the structure) brings its first box into view.
  useEffect(() => {
    if (!selectedId) return;
    host.current
      ?.querySelector('.pdft-outline--selected, .pdft-frame')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [selectedId, shown]);

  const selectedNode = selectedId && selectedId !== 'page' ? (find(doc, selectedId)?.node ?? null) : null;
  const framed = selectedNode && layerElementId(doc, selectedNode.id) === selectedNode.id ? selectedNode : null;

  return (
    <div
      ref={host}
      className={`pdft-pages${tool ? ' pdft-pages--tool' : ''}${interaction.overElement ? ' pdft-pages--element' : ''}`}
      role={props.readOnly ? 'region' : 'application'}
      aria-roledescription={props.readOnly ? undefined : 'page preview'}
      // The region takes the arrow keys that nudge the selected page element, and a scrollable region must be
      // reachable by keyboard, so it is focusable.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      data-canvas-region={props.readOnly ? undefined : true}
      aria-label="Page preview"
    >
      {!shown && <InlineLoading description="Rendering the preview…" />}
      {shown &&
        pages?.map((page, index) => {
          const number = index + 1;
          const k = PX_PER_MM * scale;
          const pageBoxes = (boxes ?? []).filter((b) => b.page === number);
          return (
            <div key={number} className="pdft-pagewrap" style={{ width: page.width * k, height: page.height * k }}>
              <span className="pdft-pno">
                Page {number} of {pages.length}
              </span>
              <div className="pdft-page" style={{ width: page.width * k, height: page.height * k }}>
                {shown.doc && (
                  <PdfPageCanvas
                    doc={shown.doc}
                    pageNumber={number}
                    scale={scale}
                    label={`Page ${number} of ${pages.length}`}
                  />
                )}
                {!props.readOnly && (
                  <div
                    className="pdft-overlay"
                    data-page={number}
                    onPointerDown={(event) => interaction.onPointerDown(event, number)}
                    onPointerMove={(event) => interaction.onPointerMove(event, number)}
                    onPointerLeave={() => props.onHover(null)}
                  >
                    {pageBoxes
                      .filter((b) => hoverIds.has(b.nodeId) && !selectedIds.has(b.nodeId))
                      .sort(bySizeDesc)
                      .map((b, i) => (
                        <div
                          key={`h${i}`}
                          className="pdft-outline pdft-outline--hover"
                          style={rect(b, k, MIN_OUTLINE_PX)}
                        />
                      ))}
                    {pageBoxes
                      .filter((b) => selectedIds.has(b.nodeId) && !(framed && b.nodeId === framed.id))
                      .sort(bySizeDesc)
                      .map((b, i) => (
                        <div
                          key={`s${i}`}
                          className="pdft-outline pdft-outline--selected"
                          style={rect(b, k, MIN_OUTLINE_PX)}
                        />
                      ))}
                    {framed && <Frame node={framed} boxes={pageBoxes} page={number} drag={drag} k={k} />}
                    {drawing?.page === number && <div className="pdft-drawrect" style={drawStyle(drawing, k)} />}
                  </div>
                )}
              </div>
            </div>
          );
        })}
    </div>
  );
}

/** Thinnest outline in px: a line (zero height) or a hairline still shows, centred on where it is. */
const MIN_OUTLINE_PX = 4;
const rect = (g: { x: number; y: number; w: number; h: number }, k: number, min = 1) => {
  const width = Math.max(g.w * k, min);
  const height = Math.max(g.h * k, min);
  return { left: g.x * k - (width - g.w * k) / 2, top: g.y * k - (height - g.h * k) / 2, width, height };
};
/** Bigger boxes first, so smaller ones are drawn on top of them. */
const bySizeDesc = (a: PdfTemplateBox, b: PdfTemplateBox) => b.w * b.h - a.w * a.h;

function drawStyle(drawing: Parameters<typeof drawnRect>[0], k: number) {
  const r = drawnRect(drawing);
  const tall = r.h === 0 && drawing.type !== 'line' ? 6 : r.h;
  return rect({ ...r, h: drawing.type === 'line' ? r.h : Math.max(tall, r.h) }, k);
}

/** The selection frame of a page-layer element, with resize handles and, while it is dragged, the live mm readout. */
function Frame({
  node,
  boxes,
  page,
  drag,
  k,
}: {
  node: TemplateNode;
  boxes: readonly PdfTemplateBox[];
  page: number;
  drag: DragState | null;
  k: number;
}) {
  const own = boxes.find((b) => b.nodeId === node.id);
  const dragging = drag?.id === node.id ? drag : null;
  if (dragging && dragging.page !== page) return null;
  if (!own && !dragging) return null;
  const geometry = dragging ? dragging.current : frameGeometry(node, own!);
  const handles = handlesFor(node);
  return (
    <div className={`pdft-frame${dragging?.moved ? ' pdft-frame--dragging' : ''}`} style={rect(geometry, k)}>
      {handles.map((dir) => (
        <span key={dir} className={`pdft-handle pdft-handle--${dir}`} data-handle={dir} aria-hidden="true" />
      ))}
      {dragging?.moved && (
        <span className="pdft-readout">
          x {geometry.x} y {geometry.y} w {geometry.w}
          {handles.length === 8 ? ` h ${geometry.h}` : ''} mm
        </span>
      )}
    </div>
  );
}
