import { Button, FileUploaderDropContainer, InlineNotification } from '@carbon/react';
import { Camera } from '@carbon/icons-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { KioskCameraSettings } from '../../../api/generated/models';
import { CameraIndicator } from '../../kiosk/camera/CameraIndicator';
import { cropSourceRect, drawCrop, squareInView, viewAround, viewPlacement } from '../../kiosk/camera/cameraCrop';
import { openKioskCamera } from '../../kiosk/camera/cameraStream';
import { ProfilePhotoCropper } from '../../users/ProfilePhotoCropper';

export type ProfileImage = { base64: string; filename: string; preview: string };

const maxImageBytes = 8 * 1024 * 1024;
/** Seconds between pressing "Take photo" and the capture, so people can look up into the lens. */
export const countdownSeconds = 3;

/** Which photo sources the kiosk device offers: its effective `camera` and `file_upload` capabilities. */
export type PhotoSources = { camera: boolean; upload: boolean };

// Camera capture or upload, then positioning under a round mask. The camera is released as soon as a photo exists or
// the step is left. Renders nothing on a device that offers neither source (the photo is then not required).
// The kiosk's calibrated crop decides which square of the camera frame is captured. The live preview shows a little
// more of the frame around it with that square marked, so people can step into place; the lens pointer and a hint
// tell them where to look.
export function ProfilePhotoPicker({
  image,
  sources,
  required,
  camera,
  actionsTarget,
  onPositioning,
  onConfirmed,
  onChange,
}: {
  image: ProfileImage | undefined;
  sources: PhotoSources;
  /** Whether the visit cannot continue without a photo; decides how the hint is worded. */
  required: boolean;
  /** The kiosk's camera calibration; missing means the centred largest square and no lens pointer. */
  camera?: KioskCameraSettings;
  /** Where the positioning step puts its "Retake photo" and "Use photo" buttons, e.g. the wizard footer. */
  actionsTarget?: Element | null;
  /** Reports whether a photo is being positioned, so the wizard can swap its own buttons for those. */
  onPositioning?: (positioning: boolean) => void;
  /** Called after "Use photo" made the photo the profile image. */
  onConfirmed?: () => void;
  onChange: (image: ProfileImage | undefined) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | undefined>(undefined);
  const [cameraOn, setCameraOn] = useState(false);
  // The captured or chosen picture that is being positioned; it only becomes the profile image once confirmed.
  const [source, setSource] = useState<string>();
  const [error, setError] = useState('');
  const [frame, setFrame] = useState<{ width: number; height: number }>();
  // Seconds left before the capture; undefined while no countdown runs.
  const [countdown, setCountdown] = useState<number>();
  const stopCamera = () => {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = undefined;
    setCameraOn(false);
    setCountdown(undefined);
  };
  useEffect(() => () => stream.current?.getTracks().forEach((track) => track.stop()), []);
  useEffect(() => {
    onPositioning?.(Boolean(source));
  }, [source, onPositioning]);
  // The video element is not mounted while a photo is being positioned; when the camera is restarted from there, the
  // stream is attached once it is back.
  useEffect(() => {
    if (cameraOn && video.current && stream.current && video.current.srcObject !== stream.current) {
      video.current.srcObject = stream.current;
    }
  });

  const loadImage = async (file: File) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Choose a JPEG, PNG, or WebP image.');
      return;
    }
    if (file.size > maxImageBytes) {
      setError('Choose an image no larger than 8 MiB.');
      return;
    }
    try {
      setSource(await blobToDataURL(file));
      stopCamera();
      setError('');
    } catch {
      setError('The photo could not be read. Choose another image.');
    }
  };
  const startCamera = async () => {
    try {
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = await openKioskCamera();
      if (video.current) video.current.srcObject = stream.current;
      setCameraOn(true);
      setError('');
    } catch {
      setError(
        sources.upload
          ? 'Camera access failed. You can upload a photo instead.'
          : 'Camera access failed. Ask a staff member.',
      );
    }
  };
  const capture = () => {
    const source = video.current;
    if (!source?.videoWidth) {
      setError('Wait for the camera preview before taking the photo.');
      return;
    }
    const canvas = document.createElement('canvas');
    // The preview shows exactly this square of the frame, so the photo takes the same region.
    const rect = cropSourceRect(camera?.crop, source.videoWidth, source.videoHeight);
    const side = Math.round(rect.side);
    canvas.width = side;
    canvas.height = side;
    drawCrop(canvas.getContext('2d')!, source, rect, side, Boolean(camera?.mirror));
    setSource(canvas.toDataURL('image/jpeg', 0.9));
    stopCamera();
    setError('');
  };
  const confirmCrop = async (photo: Blob) => {
    try {
      const preview = await blobToDataURL(photo);
      onChange({ base64: preview.slice(preview.indexOf(',') + 1), filename: 'profile-photo.jpg', preview });
      setSource(undefined);
      setError('');
      onConfirmed?.();
    } catch {
      setError('The photo could not be read. Choose another image.');
    }
  };
  // Counts down once a second and captures at zero; leaving the step or cancelling stops it.
  useEffect(() => {
    if (countdown === undefined) return;
    if (countdown === 0) {
      setCountdown(undefined);
      capture();
      return;
    }
    const timer = window.setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => window.clearTimeout(timer);
    // capture reads the current video element and calibration; the countdown value alone drives the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown]);
  const startCountdown = () => {
    if (!video.current?.videoWidth) {
      setError('Wait for the camera preview before taking the photo.');
      return;
    }
    setError('');
    setCountdown(countdownSeconds);
  };
  const replace = () => {
    onChange(undefined);
    if (sources.camera) void startCamera();
  };

  if (!sources.camera && !sources.upload) return null;

  const live = cameraOn && !image;
  const square = frame ? cropSourceRect(camera?.crop, frame.width, frame.height) : undefined;
  const view = frame && square ? viewAround(square, frame.width, frame.height) : undefined;
  const photoAction = (
    <>
      {image ? (
        <Button
          type="button"
          kind="tertiary"
          size="xl"
          className="visitor-photo__button"
          renderIcon={sources.camera ? Camera : undefined}
          onClick={replace}
        >
          {sources.camera ? 'Retake photo' : 'Choose another photo'}
        </Button>
      ) : cameraOn && countdown !== undefined ? (
        <Button
          type="button"
          kind="secondary"
          size="xl"
          className="visitor-photo__button"
          onClick={() => setCountdown(undefined)}
        >
          Cancel
        </Button>
      ) : cameraOn ? (
        <Button type="button" size="xl" className="visitor-photo__button" renderIcon={Camera} onClick={startCountdown}>
          Take photo
        </Button>
      ) : (
        sources.camera && (
          <Button
            type="button"
            kind="secondary"
            size="xl"
            className="visitor-photo__button"
            renderIcon={Camera}
            onClick={() => void startCamera()}
          >
            Start camera
          </Button>
        )
      )}
    </>
  );

  return (
    <div className={!image && !cameraOn && !source ? 'visitor-photo visitor-photo--idle' : 'visitor-photo'}>
      {sources.camera && <CameraIndicator indicator={camera?.indicator} live={cameraOn && !image && !source} />}
      {source ? (
        <ProfilePhotoCropper
          src={source}
          touch
          actionsTarget={actionsTarget}
          cancelLabel={sources.camera ? 'Retake photo' : 'Choose another'}
          onConfirm={(photo) => void confirmCrop(photo)}
          onCancel={() => {
            setSource(undefined);
            setError('');
            // "Retake photo" goes straight back to the live camera.
            if (sources.camera) void startCamera();
          }}
        />
      ) : (
        <>
          <div
            className={
              image
                ? 'visitor-photo__frame visitor-photo__frame--round'
                : live && view
                  ? 'visitor-photo__frame visitor-photo__frame--live'
                  : cameraOn
                    ? 'visitor-photo__frame'
                    : 'visitor-photo__frame visitor-photo__frame--idle'
            }
            style={live && view ? ({ '--view-aspect': view.width / view.height } as CSSProperties) : undefined}
          >
            {image && <img className="visitor-photo__media" src={image.preview} alt="Selected profile" />}
            {live && square && view && (
              <span
                className="visitor-photo__square"
                style={squareInView(square, view, camera?.mirror)}
                data-testid="photo-square"
                aria-hidden="true"
              >
                <span className="visitor-photo__guide" />
              </span>
            )}
            <video
              ref={video}
              autoPlay
              muted
              playsInline
              aria-label="Camera preview"
              className="visitor-photo__media"
              hidden={!cameraOn || Boolean(image)}
              style={frame && view ? viewPlacement(view, frame.width, frame.height, camera?.mirror) : undefined}
              onLoadedMetadata={(event) => {
                const { videoWidth, videoHeight } = event.currentTarget;
                if (videoWidth && videoHeight) setFrame({ width: videoWidth, height: videoHeight });
              }}
              onResize={(event) => {
                const { videoWidth, videoHeight } = event.currentTarget;
                if (videoWidth && videoHeight) setFrame({ width: videoWidth, height: videoHeight });
              }}
            />
            {/* While live the button sits on the picture, so it is reachable without scrolling. */}
            {live && view && <p className="visitor-photo__look">Look into the camera, not at the screen</p>}
            {live && view && <div className="visitor-photo__overlay-actions">{photoAction}</div>}
            {!image && !cameraOn && sources.camera && <div className="visitor-photo__start">{photoAction}</div>}
            {countdown !== undefined && countdown > 0 && (
              <span className="camera-countdown" aria-hidden="true">
                <span key={countdown} className="camera-countdown__number">
                  {countdown}
                </span>
              </span>
            )}
          </div>
          <p className="cds--visually-hidden" aria-live="assertive" aria-atomic="true">
            {countdown !== undefined && countdown > 0 ? `Taking the photo in ${countdown}` : ''}
          </p>
          {image && <div className="visitor-photo__actions">{photoAction}</div>}
          {sources.upload && (
            <FileUploaderDropContainer
              accept={['image/jpeg', 'image/png', 'image/webp']}
              labelText={sources.camera ? 'or upload a profile photo' : 'Upload a profile photo'}
              multiple={false}
              onAddFiles={(_, details) => {
                const file = details.addedFiles[0];
                if (file) void loadImage(file);
              }}
            />
          )}
        </>
      )}
      {/* While the photo is positioned the screen belongs to it; the hint returns afterwards. */}
      {!source && (
        <p className="visitor-photo__hint">
          {required ? 'A real photo is required for identification.' : 'A photo is optional.'}
        </p>
      )}
      {error && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Photo unavailable" subtitle={error} />
      )}
    </div>
  );
}

function blobToDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
