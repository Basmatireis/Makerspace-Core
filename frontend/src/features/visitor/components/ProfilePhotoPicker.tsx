import { Button, FileUploaderDropContainer, InlineNotification } from '@carbon/react';
import { Camera, UserAvatar } from '@carbon/icons-react';
import { useEffect, useRef, useState } from 'react';
import { ProfilePhotoCropper } from '../../users/ProfilePhotoCropper';

export type ProfileImage = { base64: string; filename: string; preview: string };

const maxImageBytes = 8 * 1024 * 1024;

/** Which photo sources the kiosk device offers: its effective `camera` and `file_upload` capabilities. */
export type PhotoSources = { camera: boolean; upload: boolean };

// Camera capture or upload, then positioning under a round mask. The camera is released as soon as a photo exists or
// the step is left. Renders nothing on a device that offers neither source (the photo is then not required).
export function ProfilePhotoPicker({
  image,
  sources,
  required,
  onChange,
}: {
  image: ProfileImage | undefined;
  sources: PhotoSources;
  /** Whether the visit cannot continue without a photo; decides how the hint is worded. */
  required: boolean;
  onChange: (image: ProfileImage | undefined) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | undefined>(undefined);
  const [cameraOn, setCameraOn] = useState(false);
  // The captured or chosen picture that is being positioned; it only becomes the profile image once confirmed.
  const [source, setSource] = useState<string>();
  const [error, setError] = useState('');
  const stopCamera = () => {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = undefined;
    setCameraOn(false);
  };
  useEffect(() => () => stream.current?.getTracks().forEach((track) => track.stop()), []);

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
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
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
    canvas.width = source.videoWidth;
    canvas.height = source.videoHeight;
    canvas.getContext('2d')!.drawImage(source, 0, 0);
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
    } catch {
      setError('The photo could not be read. Choose another image.');
    }
  };
  const replace = () => {
    onChange(undefined);
    if (sources.camera) void startCamera();
  };

  if (!sources.camera && !sources.upload) return null;

  return (
    <div className="visitor-photo">
      <p className="cds--label">Profile photo</p>
      {source ? (
        <ProfilePhotoCropper
          src={source}
          onConfirm={(photo) => void confirmCrop(photo)}
          onCancel={() => {
            setSource(undefined);
            setError('');
          }}
        />
      ) : (
        <>
          <div className={image ? 'visitor-photo__frame visitor-photo__frame--round' : 'visitor-photo__frame'}>
            {image ? (
              <img className="visitor-photo__media" src={image.preview} alt="Selected profile" />
            ) : (
              !cameraOn && <UserAvatar size={64} aria-hidden="true" className="visitor-photo__placeholder" />
            )}
            <video
              ref={video}
              autoPlay
              muted
              playsInline
              aria-label="Camera preview"
              className="visitor-photo__media"
              hidden={!cameraOn || Boolean(image)}
            />
          </div>
          <div className="visitor-photo__actions">
            {image ? (
              <Button
                type="button"
                kind="tertiary"
                size="md"
                renderIcon={sources.camera ? Camera : undefined}
                onClick={replace}
              >
                {sources.camera ? 'Retake photo' : 'Choose another photo'}
              </Button>
            ) : cameraOn ? (
              <Button type="button" size="md" renderIcon={Camera} onClick={capture}>
                Take photo
              </Button>
            ) : (
              sources.camera && (
                <Button type="button" kind="secondary" size="md" renderIcon={Camera} onClick={() => void startCamera()}>
                  Start camera
                </Button>
              )
            )}
          </div>
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
      <p className="visitor-photo__hint">
        {required
          ? 'A real photo is required for identification. Metadata is removed by the server.'
          : 'A photo is optional. Metadata is removed by the server.'}
      </p>
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
