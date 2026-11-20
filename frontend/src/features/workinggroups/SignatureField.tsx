import { useEffect, useRef, useState } from 'react';
import { Button, ContentSwitcher, Slider, Switch } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { savedSignatureOptions } from './projectQueries';

export const BOX_WIDTH = 400;
export const BOX_HEIGHT = 150;
const SCALE = 2;

export type SignatureValue = { png: string } | { useSaved: true } | null;
type Mode = 'draw' | 'upload' | 'saved';

const base64 = (dataUrl: string) => dataUrl.replace(/^data:image\/png;base64,/, '');

/** The signature of the Projektantrag: drawn on a pad, an uploaded image placed freely, or the saved one. */
export function SignatureField({
  onChange,
  onSavedAvailable,
}: {
  onChange: (value: SignatureValue) => void;
  onSavedAvailable?: (available: boolean) => void;
}) {
  const saved = useQuery(savedSignatureOptions);
  const hasSaved = saved.isSuccess;
  const [mode, setMode] = useState<Mode>('draw');
  useEffect(() => onSavedAvailable?.(hasSaved), [hasSaved, onSavedAvailable]);
  const modes: Mode[] = hasSaved ? ['draw', 'upload', 'saved'] : ['draw', 'upload'];
  const labels = { draw: 'Sign on screen', upload: 'Upload an image', saved: 'Saved signature' };

  return (
    <fieldset className="wg-sig">
      <legend>Signature</legend>
      <ContentSwitcher
        size="md"
        selectedIndex={modes.indexOf(mode)}
        onChange={({ name }) => {
          setMode(name as Mode);
          onChange(name === 'saved' ? { useSaved: true } : null);
        }}
      >
        {modes.map((key) => (
          <Switch key={key} name={key} text={labels[key]} />
        ))}
      </ContentSwitcher>
      {mode === 'draw' && <DrawPad onChange={onChange} />}
      {mode === 'upload' && <UploadPad onChange={onChange} />}
      {mode === 'saved' && saved.data && <SavedPreview blob={saved.data} />}
    </fieldset>
  );
}

function SavedPreview({ blob }: { blob: Blob }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (typeof URL.createObjectURL !== 'function') return;
    const created = URL.createObjectURL(blob);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [blob]);
  return <div className="wg-sig__box">{url && <img src={url} alt="Saved signature" className="wg-sig__saved" />}</div>;
}

function DrawPad({ onChange }: { onChange: (value: SignatureValue) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = rect.width || BOX_WIDTH;
    const height = rect.height || BOX_HEIGHT;
    return {
      x: ((event.clientX - rect.left) / width) * BOX_WIDTH * SCALE,
      y: ((event.clientY - rect.top) / height) * BOX_HEIGHT * SCALE,
    };
  };
  const context = () => {
    const ctx = canvas.current?.getContext('2d');
    if (ctx) {
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#161616';
    }
    return ctx;
  };
  return (
    <div>
      <div className="wg-sig__box">
        <canvas
          ref={canvas}
          className="wg-sig__canvas"
          width={BOX_WIDTH * SCALE}
          height={BOX_HEIGHT * SCALE}
          role="img"
          aria-label="Signature pad"
          onPointerDown={(event) => {
            drawing.current = true;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            const ctx = context();
            const p = point(event);
            ctx?.beginPath();
            ctx?.moveTo(p.x, p.y);
          }}
          onPointerMove={(event) => {
            if (!drawing.current) return;
            const p = point(event);
            const ctx = context();
            ctx?.lineTo(p.x, p.y);
            ctx?.stroke();
          }}
          onPointerUp={() => {
            if (!drawing.current) return;
            drawing.current = false;
            const png = canvas.current?.toDataURL('image/png');
            if (png) onChange({ png: base64(png) });
          }}
        />
      </div>
      <Button
        kind="ghost"
        size="sm"
        onClick={() => {
          const el = canvas.current;
          el?.getContext('2d')?.clearRect(0, 0, el.width, el.height);
          onChange(null);
        }}
      >
        Clear
      </Button>
    </div>
  );
}

function UploadPad({ onChange }: { onChange: (value: SignatureValue) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [image, setImage] = useState<{ url: string; element: HTMLImageElement } | null>(null);
  const [fit, setFit] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const width = image ? image.element.naturalWidth * fit * (zoom / 100) : 0;
  const height = image ? image.element.naturalHeight * fit * (zoom / 100) : 0;

  useEffect(() => {
    if (!image) return;
    const out = document.createElement('canvas');
    out.width = BOX_WIDTH * SCALE;
    out.height = BOX_HEIGHT * SCALE;
    const ctx = out.getContext('2d');
    ctx?.drawImage(image.element, offset.x * SCALE, offset.y * SCALE, width * SCALE, height * SCALE);
    const png = out.toDataURL('image/png');
    onChange(png ? { png: base64(png) } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompose only when the placement changes
  }, [image, offset.x, offset.y, width, height]);

  useEffect(
    () => () => {
      if (image) URL.revokeObjectURL(image.url);
    },
    [image],
  );

  const load = (file: File) => {
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      setError('Only PNG or JPEG.');
      return;
    }
    setError(null);
    const url = URL.createObjectURL(file);
    const element = new Image();
    element.onload = () => {
      const w = element.naturalWidth || BOX_WIDTH;
      const h = element.naturalHeight || BOX_HEIGHT;
      const scale = Math.min(BOX_WIDTH / w, BOX_HEIGHT / h);
      setFit(scale);
      setZoom(100);
      setOffset({ x: (BOX_WIDTH - w * scale) / 2, y: (BOX_HEIGHT - h * scale) / 2 });
      setImage({ url, element });
    };
    element.onerror = () => setError('The image could not be read.');
    element.src = url;
  };

  return (
    <div>
      <input
        ref={input}
        type="file"
        className="wg-visually-hidden"
        tabIndex={-1}
        accept="image/png,image/jpeg"
        aria-label="Signature image"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) load(file);
        }}
      />
      <Button kind="tertiary" size="md" onClick={() => input.current?.click()}>
        {image ? 'Choose another image' : 'Choose an image'}
      </Button>
      {error && <p className="wg-buyrow__error">{error}</p>}
      <div
        ref={box}
        className="wg-sig__box wg-sig__box--drag"
        onPointerDown={(event) => {
          if (!image) return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const rect = box.current?.getBoundingClientRect();
          const ratio = rect && rect.width ? BOX_WIDTH / rect.width : 1;
          setOffset({
            x: drag.current.ox + (event.clientX - drag.current.x) * ratio,
            y: drag.current.oy + (event.clientY - drag.current.y) * ratio,
          });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        {image && (
          <img
            src={image.url}
            alt="Signature preview"
            draggable={false}
            className="wg-sig__img"
            style={{
              left: `${(offset.x / BOX_WIDTH) * 100}%`,
              top: `${(offset.y / BOX_HEIGHT) * 100}%`,
              width: `${(width / BOX_WIDTH) * 100}%`,
            }}
          />
        )}
      </div>
      {image && (
        <Slider
          id="wg-sig-size"
          labelText="Size"
          min={20}
          max={300}
          step={5}
          value={zoom}
          onChange={({ value }) => setZoom(value)}
        />
      )}
    </div>
  );
}
