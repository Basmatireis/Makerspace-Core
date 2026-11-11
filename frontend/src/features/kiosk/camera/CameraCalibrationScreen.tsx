import { Button, InlineNotification, RadioButton, RadioButtonGroup, Slider, Stack, Toggle } from '@carbon/react';
import { Checkmark, Close } from '@carbon/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  cancelTerminalCameraCalibration,
  saveTerminalCameraCalibration,
} from '../../../api/generated/attendance/attendance';
import type {
  KioskCameraCrop,
  KioskCameraIndicator,
  KioskCameraIndicatorEdge,
  KioskCameraSettings,
} from '../../../api/generated/models';
import { apiErrorCode } from '../../../api/http-client';
import { formatTime } from '../../../app/dateTime';
import { CameraIndicator } from './CameraIndicator';
import { clampCrop, cropSourceRect, defaultCrop, displayedRect, minCropSize, previewPlacement } from './cameraCrop';
import { openKioskCamera } from './cameraStream';
import './calibration.scss';

const edgeLabels: Record<KioskCameraIndicatorEdge, string> = {
  top: 'Top',
  right: 'Right',
  bottom: 'Bottom',
  left: 'Left',
};

type Frame = { width: number; height: number };

/**
 * Calibration on the tablet itself, shown while an administrator's calibration window is open: the whole camera frame
 * with the photo square to drag and pinch, the resulting photo, and the lens pointer drawn live at the screen edge so
 * it can be lined up with the physical lens. Saving or cancelling closes the window on the server.
 */
export function CameraCalibrationScreen({
  camera,
  expiresAt,
  onDone,
}: {
  camera: KioskCameraSettings | undefined;
  expiresAt: string;
  onDone: () => void;
}) {
  const frameVideo = useRef<HTMLVideoElement>(null);
  const photoVideo = useRef<HTMLVideoElement>(null);
  const frameBox = useRef<HTMLDivElement>(null);
  const stream = useRef<MediaStream | undefined>(undefined);
  const [frame, setFrame] = useState<Frame>();
  const [cameraError, setCameraError] = useState(false);
  const [crop, setCrop] = useState<KioskCameraCrop>(camera?.crop ?? defaultCrop);
  const [mirror, setMirror] = useState(Boolean(camera?.mirror));
  const [indicatorOn, setIndicatorOn] = useState(Boolean(camera?.indicator));
  const [indicator, setIndicator] = useState<KioskCameraIndicator>(camera?.indicator ?? { edge: 'top', offset: 50 });
  // Active pointers on the frame: one drags the square, two pinch its size.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ crop: KioskCameraCrop; distance?: number; x: number; y: number }>(undefined);

  useEffect(() => {
    let cancelled = false;
    openKioskCamera()
      .then((media) => {
        if (cancelled) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream.current = media;
        if (frameVideo.current) frameVideo.current.srcObject = media;
        if (photoVideo.current) photoVideo.current.srcObject = media;
      })
      .catch(() => setCameraError(true));
    return () => {
      cancelled = true;
      stream.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const settings = (): KioskCameraSettings => ({
    crop: frame ? clampCrop(crop, frame.width, frame.height) : crop,
    indicator: indicatorOn ? indicator : null,
    mirror,
  });
  const save = useMutation({ mutationFn: () => saveTerminalCameraCalibration(settings()), onSuccess: onDone });
  const cancel = useMutation({ mutationFn: () => cancelTerminalCameraCalibration(), onSettled: onDone });
  const closed = apiErrorCode(save.error) === 'camera_calibration_closed';

  const rect = frame ? cropSourceRect(crop, frame.width, frame.height) : undefined;
  // The frame is shown the way the wizard will show it, so the square is drawn where it appears on screen.
  const shown = frame && rect ? displayedRect(rect, frame.width, mirror) : undefined;
  const pointerAt = (event: ReactPointerEvent) => ({ x: event.clientX, y: event.clientY });
  const spread = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : undefined;
  };
  const beginGesture = () => {
    const [first] = [...pointers.current.values()];
    if (first) gesture.current = { crop, distance: spread(), ...first };
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, pointerAt(event));
    beginGesture();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current || !frame || !frameBox.current) return;
    pointers.current.set(event.pointerId, pointerAt(event));
    const start = gesture.current;
    const box = frameBox.current.getBoundingClientRect();
    if (start.distance && pointers.current.size > 1) {
      // Spreading the fingers zooms in: the photo square gets smaller.
      const ratio = start.distance / (spread() ?? start.distance);
      setCrop({ ...start.crop, size: Math.min(1, Math.max(minCropSize, start.crop.size * ratio)) });
      return;
    }
    const [first] = [...pointers.current.values()];
    if (!first) return;
    setCrop(
      clampCrop(
        {
          ...start.crop,
          // The mirrored frame moves the other way on screen than the unmirrored source coordinates.
          centerX: start.crop.centerX + ((mirror ? -1 : 1) * (first.x - start.x)) / box.width,
          centerY: start.crop.centerY + (first.y - start.y) / box.height,
        },
        frame.width,
        frame.height,
      ),
    );
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    beginGesture();
  };

  return (
    <main className="camera-calibration">
      <CameraIndicator indicator={indicatorOn ? indicator : null} live />
      <Stack gap={3}>
        <h1 className="camera-calibration__title">Calibrate the camera</h1>
        <p className="camera-calibration__lead">
          Move and size the square so a face in front of the tablet sits naturally in the photo, then line the pointer
          up with the camera lens. Open until {formatTime(expiresAt)}.
        </p>
      </Stack>
      {cameraError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Camera unavailable"
          subtitle="Allow camera access for this page, or cancel the calibration."
        />
      )}
      {save.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Calibration not saved"
          subtitle={
            closed
              ? 'The calibration window has closed. Start it again in the device settings.'
              : 'Check the values and try again.'
          }
        />
      )}
      <div className="camera-calibration__body">
        <div
          ref={frameBox}
          className="camera-calibration__frame"
          style={{ aspectRatio: frame ? `${frame.width} / ${frame.height}` : '16 / 9' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <video
            ref={frameVideo}
            autoPlay
            muted
            playsInline
            aria-label="Whole camera image"
            style={mirror ? { transform: 'scaleX(-1)' } : undefined}
            onLoadedMetadata={(event) => {
              const { videoWidth, videoHeight } = event.currentTarget;
              if (videoWidth && videoHeight) setFrame({ width: videoWidth, height: videoHeight });
            }}
          />
          {frame && shown && (
            <span
              className="camera-calibration__crop"
              data-testid="calibration-crop"
              style={{
                left: `${(shown.x / frame.width) * 100}%`,
                top: `${(shown.y / frame.height) * 100}%`,
                width: `${(shown.side / frame.width) * 100}%`,
                height: `${(shown.side / frame.height) * 100}%`,
              }}
            />
          )}
        </div>
        <div className="camera-calibration__side">
          <Stack gap={3}>
            <p className="cds--label">The photo</p>
            <div className="camera-calibration__photo">
              <video
                ref={photoVideo}
                autoPlay
                muted
                playsInline
                aria-label="Photo preview"
                style={frame && rect ? previewPlacement(rect, frame.width, frame.height, mirror) : undefined}
              />
            </div>
          </Stack>
          <Slider
            id="calibration-size"
            labelText="Square size (% of the shorter side)"
            min={minCropSize * 100}
            max={100}
            step={1}
            value={Math.round(crop.size * 100)}
            onChange={({ value }) => setCrop((current) => ({ ...current, size: value / 100 }))}
          />
          <Toggle
            id="calibration-mirror"
            labelText="Mirror image"
            labelA="Off"
            labelB="On"
            toggled={mirror}
            onToggle={setMirror}
          />
          <Toggle
            id="calibration-indicator"
            labelText="Camera pointer"
            labelA="Off"
            labelB="On"
            toggled={indicatorOn}
            onToggle={setIndicatorOn}
          />
          {indicatorOn && (
            <>
              <RadioButtonGroup
                legendText="Screen edge next to the lens"
                name="calibration-edge"
                valueSelected={indicator.edge}
                onChange={(value) =>
                  setIndicator((current) => ({ ...current, edge: value as KioskCameraIndicatorEdge }))
                }
              >
                {(Object.keys(edgeLabels) as KioskCameraIndicatorEdge[]).map((edge) => (
                  <RadioButton key={edge} id={`calibration-edge-${edge}`} value={edge} labelText={edgeLabels[edge]} />
                ))}
              </RadioButtonGroup>
              <Slider
                id="calibration-offset"
                labelText={
                  indicator.edge === 'top' || indicator.edge === 'bottom'
                    ? 'Position from the left (%)'
                    : 'Position from the top (%)'
                }
                min={0}
                max={100}
                step={0.5}
                value={indicator.offset}
                onChange={({ value }) => setIndicator((current) => ({ ...current, offset: value }))}
              />
            </>
          )}
          <div className="camera-calibration__actions">
            <Button
              kind="secondary"
              renderIcon={Close}
              disabled={save.isPending || cancel.isPending}
              onClick={() => (closed ? onDone() : cancel.mutate())}
            >
              Cancel
            </Button>
            <Button
              renderIcon={Checkmark}
              disabled={save.isPending || cancel.isPending || closed}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save calibration'}
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}
