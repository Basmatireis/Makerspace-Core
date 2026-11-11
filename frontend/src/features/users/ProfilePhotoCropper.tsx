import { Button, InlineNotification, Slider } from '@carbon/react';
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  clampCropView,
  cropSourceRect,
  imageExtent,
  maxZoom,
  minZoom,
  renderCrop,
  type CropView,
} from './profilePhotoCrop';
import './photo-cropper.scss';

const keyStep = 0.02;
const keyStepLarge = 0.1;

type Natural = { width: number; height: number };

/**
 * Positions a photo under a round mask: drag (touch or mouse) or use the arrow keys to move it, pinch or use the slider
 * to zoom. Confirming hands back the square under the mask as a 512x512 JPEG, which is what gets uploaded. `touch`
 * lays it out for the kiosk tablet: large controls and a hint without keyboard keys.
 */
export function ProfilePhotoCropper({
  src,
  confirmLabel = 'Use photo',
  cancelLabel = 'Choose another',
  busy = false,
  touch = false,
  actionsTarget,
  onConfirm,
  onCancel,
}: {
  src: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  touch?: boolean;
  /** Renders the cancel and confirm buttons there instead of under the photo, e.g. into a wizard's footer. */
  actionsTarget?: Element | null;
  onConfirm: (photo: Blob) => void;
  onCancel: () => void;
}) {
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<{ pointer: number; startX: number; startY: number; view: CropView; size: number }>(undefined);
  // Fingers on the photo; with two of them the gesture zooms instead of moving.
  const fingers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number }>(undefined);
  const spread = () => {
    const [a, b] = [...fingers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const [natural, setNatural] = useState<Natural>();
  const [view, setView] = useState<CropView>({ zoom: minZoom, x: 0, y: 0 });
  const [error, setError] = useState('');

  const move = (next: CropView) => {
    if (natural) setView(clampCropView(natural.width, natural.height, next));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!natural) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    fingers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (fingers.current.size === 2) {
      drag.current = undefined;
      pinch.current = { distance: spread(), zoom: view.zoom };
      return;
    }
    drag.current = {
      pointer: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      view,
      size: event.currentTarget.getBoundingClientRect().width,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (fingers.current.has(event.pointerId)) {
      fingers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (pinch.current && fingers.current.size === 2 && pinch.current.distance > 0) {
      const zoom = (pinch.current.zoom * spread()) / pinch.current.distance;
      move({ ...view, zoom: Math.min(maxZoom, Math.max(minZoom, zoom)) });
      return;
    }
    const start = drag.current;
    if (!start || start.pointer !== event.pointerId || start.size === 0) return;
    move({
      ...start.view,
      x: start.view.x + (event.clientX - start.startX) / start.size,
      y: start.view.y + (event.clientY - start.startY) / start.size,
    });
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    fingers.current.delete(event.pointerId);
    if (fingers.current.size < 2) pinch.current = undefined;
    if (drag.current?.pointer === event.pointerId) drag.current = undefined;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? keyStepLarge : keyStep;
    const delta = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    move({ ...view, x: view.x + delta[0], y: view.y + delta[1] });
  };

  const confirm = async () => {
    if (!natural || !image.current) return;
    try {
      onConfirm(await renderCrop(image.current, cropSourceRect(natural.width, natural.height, view)));
    } catch {
      setError('The photo could not be prepared. Choose another image.');
    }
  };

  const actions = (
    <div className="photo-cropper__actions">
      <Button type="button" kind="secondary" size={touch ? 'xl' : 'md'} disabled={busy} onClick={onCancel}>
        {cancelLabel}
      </Button>
      <Button type="button" size={touch ? 'xl' : 'md'} disabled={!natural || busy} onClick={() => void confirm()}>
        {confirmLabel}
      </Button>
    </div>
  );
  const extent = natural ? imageExtent(natural.width, natural.height, view.zoom) : { width: 1, height: 1 };
  return (
    <div className={touch ? 'photo-cropper photo-cropper--touch' : 'photo-cropper'}>
      {/* Carbon has no image cropper; this is a focusable drag surface with the same keys as the pointer. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- custom drag surface: no ARIA role fits a 2-D pan, so it is a named group with documented arrow keys */}
      <div
        className="photo-cropper__mask"
        role="group"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard users must be able to reach the drag surface (see above)
        tabIndex={0}
        aria-label="Photo position"
        aria-describedby="photo-cropper-help"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <img
          ref={image}
          src={src}
          alt=""
          draggable={false}
          className="photo-cropper__image"
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget;
            if (naturalWidth > 0 && naturalHeight > 0) setNatural({ width: naturalWidth, height: naturalHeight });
          }}
          onError={() => setError('The photo could not be read. Choose another image.')}
          style={{
            inlineSize: `${extent.width * 100}%`,
            blockSize: `${extent.height * 100}%`,
            insetInlineStart: `${(0.5 + view.x - extent.width / 2) * 100}%`,
            insetBlockStart: `${(0.5 + view.y - extent.height / 2) * 100}%`,
          }}
        />
      </div>
      <div className="photo-cropper__controls">
        <p id="photo-cropper-help" className="photo-cropper__help">
          {touch
            ? 'Drag the photo to position it. Pinch or use the slider to zoom.'
            : 'Drag the photo or use the arrow keys to position it, and zoom with the slider.'}
        </p>
        <Slider
          id="photo-cropper-zoom"
          labelText="Zoom"
          min={minZoom}
          max={maxZoom}
          step={0.05}
          value={view.zoom}
          hideTextInput
          formatLabel={(value) => `${value.toFixed(1)}×`}
          disabled={!natural || busy}
          onChange={({ value }) => move({ ...view, zoom: value })}
        />
        {error && (
          <InlineNotification kind="error" lowContrast hideCloseButton title="Photo unavailable" subtitle={error} />
        )}
        {actionsTarget ? createPortal(actions, actionsTarget) : actions}
      </div>
    </div>
  );
}
