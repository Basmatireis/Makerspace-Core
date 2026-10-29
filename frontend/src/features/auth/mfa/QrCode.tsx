import { useMemo } from 'react';
import QRCode from 'qrcode';
import { QR_MARGIN, qrModulesToPath } from './qrPath';

/** Renders text as an inline SVG QR code. Loaded lazily so the encoder stays out of the initial bundle. */
export default function QrCode({ value, label, size = 200 }: { value: string; label: string; size?: number }) {
  const symbol = useMemo(() => {
    const { modules } = QRCode.create(value, { errorCorrectionLevel: 'M' });
    return { cells: modules.size, path: qrModulesToPath(modules.data, modules.size) };
  }, [value]);
  const extent = symbol.cells + 2 * QR_MARGIN;
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${extent} ${extent}`}
      shapeRendering="crispEdges"
      style={{ display: 'block' }}
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <path d={symbol.path} fill="#000000" />
    </svg>
  );
}
