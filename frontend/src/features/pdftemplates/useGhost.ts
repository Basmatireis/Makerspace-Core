import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { PdfTemplateBox, PdfTemplatePage } from '../../api/generated/models';
import { find, type TemplateDocument } from './model';
import { frameGeometry } from './overlayModel';
import { moved, sourceRect, stretchesOnResize, type Rect } from './ghost';
import type { DragState } from './usePreviewInteraction';

export interface Ghost {
  id: string;
  page: number;
  /** Where the render drew the element: what the picture was cut from and what is covered. */
  from: Rect;
  /** The copied pixels, or null where the canvas cannot be read (then the original is only hidden). */
  snap: HTMLCanvasElement | null;
  area: Rect | null;
  /** The render the copy was taken from. */
  shownAt: unknown;
  stretch: boolean;
}

/** How long a ghost waits for a render before it gives up (the render may have failed). */
const GIVE_UP_MS = 10_000;

/**
 * Keeps the rendered look of the element that is being moved, resized or nudged: the pixels are copied at the start and
 * shown at the new place until the next render has been drawn, not until the pointer is released, so nothing flashes.
 */
export function useGhost({
  host,
  doc,
  framedId,
  boxes,
  pages,
  drag,
  shown,
}: {
  host: RefObject<HTMLElement | null>;
  doc: TemplateDocument;
  framedId: string | null;
  boxes: readonly PdfTemplateBox[];
  pages: readonly PdfTemplatePage[] | undefined;
  drag: DragState | null;
  shown: unknown;
}) {
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const latestShown = useRef(shown);
  useEffect(() => {
    latestShown.current = shown;
  });

  const node = framedId ? find(doc, framedId)?.node : null;
  const own = framedId ? boxes.find((b) => b.nodeId === framedId) : undefined;
  const live: Rect | null = node && own ? (drag?.id === framedId ? drag.current : frameGeometry(node, own)) : null;
  const wanted = !!own && !!live && (drag?.id === framedId || moved(own, live));

  // Copy the pixels the moment the element starts to move (the canvas still shows the render as it was).
  useLayoutEffect(() => {
    if (!wanted || !own || !framedId || !node || ghost?.id === framedId) return;
    const canvas = host.current?.querySelector<HTMLCanvasElement>(`[data-page-wrap="${own.page}"] canvas`) ?? null;
    const dims = pages?.[own.page - 1];
    let snap: HTMLCanvasElement | null = null;
    let area: Rect | null = null;
    const src = canvas && dims ? sourceRect(own, dims, canvas) : null;
    if (canvas && src) {
      try {
        const copy = document.createElement('canvas');
        copy.width = src.sw;
        copy.height = src.sh;
        const context = copy.getContext('2d');
        context?.drawImage(canvas, src.sx, src.sy, src.sw, src.sh, 0, 0, src.sw, src.sh);
        // A tainted or unavailable canvas throws here.
        context?.getImageData(0, 0, 1, 1);
        snap = context ? copy : null;
        area = snap ? src.area : null;
      } catch {
        snap = null;
        area = null;
      }
    }
    setGhost({
      id: framedId,
      page: own.page,
      from: { x: own.x, y: own.y, w: own.w, h: own.h },
      snap,
      area,
      shownAt: shown,
      stretch: stretchesOnResize(node.type),
    });
  }, [wanted, own, framedId, node, ghost?.id, host, pages, shown]);

  // Nothing moved after all (the gesture was cancelled, an undo): the render still on the page is right.
  useEffect(() => {
    if (ghost && !wanted && !drag && ghost.shownAt === shown && ghost.id === framedId) setGhost(null);
  }, [ghost, wanted, drag, shown, framedId]);
  // A render that never arrives.
  useEffect(() => {
    if (!ghost || drag) return;
    const timer = window.setTimeout(() => setGhost(null), GIVE_UP_MS);
    return () => window.clearTimeout(timer);
  }, [ghost, drag]);

  /** The page canvas drew a render: when it is a newer one than the ghost was cut from, the ghost has done its work. */
  const onDrawn = () => {
    setGhost((now) => (now && latestShown.current !== now.shownAt ? null : now));
  };

  // Where the ghost's element is now: while dragged the live geometry, else the document's own.
  const at = (() => {
    if (!ghost) return null;
    const n = find(doc, ghost.id)?.node;
    const b = boxes.find((x) => x.nodeId === ghost.id);
    if (!n || !b) return ghost.from;
    return drag?.id === ghost.id ? drag.current : frameGeometry(n, b);
  })();
  return { ghost, at, onDrawn };
}
