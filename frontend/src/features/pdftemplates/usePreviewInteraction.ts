import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { PdfTemplateBox } from '../../api/generated/models';
import { useLatestCallback } from '../../app/useLatestCallback';
import { layerElementId, SIZED, find, type BlockType, type TemplateDocument, type ToolType } from './model';
import { dragGeometry, handlesFor, type Geometry, type Handle } from './ops';
import { frameGeometry, hitTest, snapHalf } from './overlayModel';
import { PX_PER_MM } from './renderPreview';

export interface DragState {
  id: string;
  handle: Handle | 'move';
  /** 1-based page the drag started on. */
  page: number;
  start: Geometry;
  current: Geometry;
  /** Pointer position at the start, px. */
  sx: number;
  sy: number;
  moved: boolean;
}
export interface DrawState {
  page: number;
  type: ToolType;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** A square for kinds with a size of their own while Shift is held. */
  square: boolean;
}
export interface DrawResult {
  /** 0-based index of the page drawn on. */
  pageIndex: number;
  type: ToolType;
  at: [number, number];
  size?: { w?: number; h?: number };
}
/** The rectangle a draw gesture shows and produces, in mm. */
export function drawnRect(d: DrawState): { x: number; y: number; w: number; h: number } {
  let w = Math.abs(d.x1 - d.x0);
  let h = Math.abs(d.y1 - d.y0);
  if (d.type === 'line') {
    if (w >= h) h = 0;
    else w = 0;
  } else if (d.square && SIZED.includes(d.type as BlockType)) w = h = Math.max(w, h);
  return { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w, h };
}

/** What a finished draw gesture inserts: a click takes the default size, a drag the drawn rectangle. */
export function drawResult(d: DrawState): DrawResult {
  const r = drawnRect(d);
  const dragged = r.w >= 2 || r.h >= 2;
  const sized = SIZED.includes(d.type as BlockType);
  if (!dragged) return { pageIndex: d.page - 1, type: d.type, at: [d.x0, d.y0] };
  return {
    pageIndex: d.page - 1,
    type: d.type,
    at: [r.x, r.y],
    size:
      d.type === 'line' ? (r.w >= r.h ? { w: r.w, h: 0 } : { w: 0, h: r.h }) : { w: r.w, h: sized ? r.h : undefined },
  };
}

interface Options {
  doc: TemplateDocument;
  boxes: readonly PdfTemplateBox[];
  scale: number;
  selectedId: string | null;
  tool: ToolType | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  /** A move or resize finished: the properties to set. */
  onGeometry: (id: string, patch: Record<string, number>) => void;
  onDraw: (result: DrawResult) => void;
}

const DRAG_THRESHOLD_PX = 3;

/**
 * Pointer handling of the page overlay: hover and selection through the render's boxes, move and resize of page-layer
 * elements, and drawing a new element with a tool. During a gesture only the overlay changes (`drag`, `drawing`); the
 * document changes once, on release, so a gesture is one undo step.
 */
export function usePreviewInteraction(options: Options) {
  const { doc, boxes, scale, selectedId, tool } = options;
  const [drag, setDrag] = useState<DragState | null>(null);
  const [drawing, setDrawing] = useState<DrawState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const drawRef = useRef<DrawState | null>(null);
  const pageRef = useRef<HTMLElement | null>(null);
  const [overElement, setOverElement] = useState(false);
  const live = useLatestCallback(() => options);
  const active = drag !== null || drawing !== null;

  const mmAt = useCallback(
    (event: { clientX: number; clientY: number }, element: HTMLElement): [number, number] => {
      const rect = element.getBoundingClientRect();
      const k = PX_PER_MM * scale;
      return [(event.clientX - rect.left) / k, (event.clientY - rect.top) / k];
    },
    [scale],
  );

  const startDrag = (id: string, handle: Handle | 'move', page: number, event: ReactPointerEvent) => {
    const found = find(doc, id);
    const box = boxes.find((b) => b.nodeId === id && b.page === page);
    if (!found || found.node.type === 'layer' || !box) return;
    const start = frameGeometry(found.node, box);
    const state: DragState = {
      id,
      handle,
      page,
      start,
      current: start,
      sx: event.clientX,
      sy: event.clientY,
      moved: false,
    };
    dragRef.current = state;
    setDrag(state);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>, page: number) => {
    if (event.button !== 0) return;
    const element = event.currentTarget;
    pageRef.current = element;
    if (tool && tool !== 'layer') {
      event.preventDefault();
      const [x, y] = mmAt(event, element).map(snapHalf);
      const state: DrawState = { page, type: tool, x0: x, y0: y, x1: x, y1: y, square: event.shiftKey };
      drawRef.current = state;
      setDrawing(state);
      return;
    }
    const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-handle]')?.dataset.handle as
      Handle | undefined;
    if (handle && selectedId) {
      event.preventDefault();
      startDrag(selectedId, handle, page, event);
      return;
    }
    const [x, y] = mmAt(event, element);
    const hit = hitTest(boxes, page, x, y);
    if (!hit) {
      options.onSelect(null);
      return;
    }
    const element_ = layerElementId(doc, hit.nodeId);
    const target = element_ ?? hit.nodeId;
    if (target !== selectedId) options.onSelect(target);
    if (element_) {
      event.preventDefault();
      startDrag(target, 'move', page, event);
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>, page: number) => {
    if (active || tool) return;
    const [x, y] = mmAt(event, event.currentTarget);
    const hit = hitTest(boxes, page, x, y);
    options.onHover(hit?.nodeId ?? null);
    setOverElement(!!hit && layerElementId(doc, hit.nodeId) !== null);
  };

  useEffect(() => {
    if (!active) return;
    const move = (event: PointerEvent) => {
      const { scale: k0 } = live();
      const k = PX_PER_MM * k0;
      const d = dragRef.current;
      if (d) {
        if (!d.moved && Math.hypot(event.clientX - d.sx, event.clientY - d.sy) < DRAG_THRESHOLD_PX) return;
        const current = dragGeometry(d.start, d.handle, (event.clientX - d.sx) / k, (event.clientY - d.sy) / k, {
          free: event.altKey,
          axis: event.shiftKey,
        });
        const next = { ...d, current, moved: true };
        dragRef.current = next;
        setDrag(next);
      }
      const w = drawRef.current;
      const page = pageRef.current;
      if (w && page) {
        const rect = page.getBoundingClientRect();
        const next = {
          ...w,
          x1: snapHalf((event.clientX - rect.left) / k),
          y1: snapHalf((event.clientY - rect.top) / k),
          square: event.shiftKey,
        };
        drawRef.current = next;
        setDrawing(next);
      }
    };
    const up = () => {
      const d = dragRef.current;
      const w = drawRef.current;
      dragRef.current = null;
      drawRef.current = null;
      setDrag(null);
      setDrawing(null);
      const { doc: currentDoc, onGeometry, onDraw } = live();
      if (d?.moved) {
        const node = find(currentDoc, d.id)?.node;
        const g = d.current;
        const patch: Record<string, number> = { x: g.x, y: g.y };
        if (d.handle !== 'move') {
          patch.w = g.w;
          if (node && (handlesFor(node).length === 8 || node.type === 'line')) patch.h = g.h;
        }
        onGeometry(d.id, patch);
      }
      if (w) onDraw(drawResult(w));
    };
    const cancel = () => {
      dragRef.current = null;
      drawRef.current = null;
      setDrag(null);
      setDrawing(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [active, live]);

  return { drag, drawing, overElement, onPointerDown, onPointerMove };
}
