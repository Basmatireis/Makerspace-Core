import { useMemo } from 'react';
import { qrModules } from './qr';

export function QrCode({ url, caption }: { url: string; caption: string }) {
  // Encoding a QR code is real work; the matrix only changes with the URL.
  const modules = useMemo(() => qrModules(url), [url]);
  return (
    <div className="sg-qr">
      {modules ? (
        <svg
          viewBox={`-2 -2 ${modules.length + 4} ${modules.length + 4}`}
          className="sg-qr__code"
          role="img"
          aria-label={`QR code for ${url}`}
          shapeRendering="crispEdges"
        >
          <rect x="-2" y="-2" width={modules.length + 4} height={modules.length + 4} fill="#fff" />
          {modules.flatMap((row, y) =>
            row.map((on, x) =>
              on ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="#161616" /> : null,
            ),
          )}
        </svg>
      ) : (
        <div className="sg-placeholder">Link too long for a QR code</div>
      )}
      <div className="sg-qr__text">
        <strong>{caption}</strong>
        <span>{url.replace(/^https?:\/\//, '')}</span>
      </div>
    </div>
  );
}
