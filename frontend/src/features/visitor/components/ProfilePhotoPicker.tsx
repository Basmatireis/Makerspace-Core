import { Button, FileUploaderDropContainer, InlineNotification } from '@carbon/react';
import { Camera, UserAvatar } from '@carbon/icons-react';
import { useEffect, useRef, useState } from 'react';

export type ProfileImage = { base64: string; filename: string; preview: string };

const maxImageBytes = 8 * 1024 * 1024;

// Camera capture or upload with a preview. The camera is released as soon as a photo exists or the step is left.
export function ProfilePhotoPicker({
  image,
  onChange,
}: {
  image: ProfileImage | undefined;
  onChange: (image: ProfileImage | undefined) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | undefined>(undefined);
  const [cameraOn, setCameraOn] = useState(false);
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
      const dataURL = await fileToDataURL(file);
      onChange({ base64: dataURL.slice(dataURL.indexOf(',') + 1), filename: file.name, preview: dataURL });
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
      setError('Camera access failed. You can upload a photo instead.');
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
    const preview = canvas.toDataURL('image/jpeg', 0.9);
    onChange({ base64: preview.slice(preview.indexOf(',') + 1), filename: 'terminal-capture.jpg', preview });
    stopCamera();
    setError('');
  };

  return (
    <div className="visitor-photo">
      <p className="cds--label">Profile photo</p>
      <div className="visitor-photo__frame">
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
            renderIcon={Camera}
            onClick={() => {
              onChange(undefined);
              void startCamera();
            }}
          >
            Retake photo
          </Button>
        ) : cameraOn ? (
          <Button type="button" size="md" renderIcon={Camera} onClick={capture}>
            Take photo
          </Button>
        ) : (
          <Button type="button" kind="secondary" size="md" renderIcon={Camera} onClick={() => void startCamera()}>
            Start camera
          </Button>
        )}
      </div>
      <FileUploaderDropContainer
        accept={['image/jpeg', 'image/png', 'image/webp']}
        labelText="or upload a profile photo"
        multiple={false}
        onAddFiles={(_, details) => {
          const file = details.addedFiles[0];
          if (file) void loadImage(file);
        }}
      />
      <p className="visitor-photo__hint">
        A real photo is required for identification. Metadata is removed by the server.
      </p>
      {error && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Photo unavailable" subtitle={error} />
      )}
    </div>
  );
}

function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
