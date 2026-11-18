import { Button, IconButton } from '@carbon/react';
import { ZoomIn, ZoomOut } from '../icons';
import { clampZoom, MAX_ZOOM, MIN_ZOOM, type Zoom } from '../../signage/editor/zoom';

/** Steps of the zoom buttons. */
export const ZOOM_STEP = 1.25;

/** Fit · 100 % · ± like the signage screen editor; Ctrl or ⌘ with the wheel zooms around the pointer. */
export function ZoomBar({ zoom, scale, onZoom }: { zoom: Zoom; scale: number; onZoom: (zoom: Zoom) => void }) {
  return (
    <div className="pdft-zoom" role="group" aria-label="Zoom">
      <IconButton
        label="Zoom out (Ctrl or ⌘ with the scroll wheel)"
        kind="ghost"
        size="sm"
        align="top"
        disabled={scale <= MIN_ZOOM}
        onClick={() => onZoom(clampZoom(scale / ZOOM_STEP))}
      >
        <ZoomOut />
      </IconButton>
      <span className="pdft-zoom__value" aria-live="polite">
        {Math.round(scale * 100)} %
      </span>
      <IconButton
        label="Zoom in (Ctrl or ⌘ with the scroll wheel)"
        kind="ghost"
        size="sm"
        align="top"
        disabled={scale >= MAX_ZOOM}
        onClick={() => onZoom(clampZoom(scale * ZOOM_STEP))}
      >
        <ZoomIn />
      </IconButton>
      <Button kind={zoom === 'fit' ? 'secondary' : 'ghost'} size="sm" onClick={() => onZoom('fit')}>
        Fit
      </Button>
      <Button kind={zoom === 1 ? 'secondary' : 'ghost'} size="sm" onClick={() => onZoom(1)}>
        100 %
      </Button>
    </div>
  );
}
