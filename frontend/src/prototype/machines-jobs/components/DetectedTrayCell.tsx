import { Tag } from '@carbon/react';
import type { DetectedTray } from '../types';

/** Live content of a printer slot as the connector reports it: colour swatch, material, remaining percent and an RFID tag. */
export function DetectedTrayCell({ tray, unknownLabel = 'Not detected' }: { tray: DetectedTray | null; unknownLabel?: string }) {
  if (!tray) return <span className="mj-secondary">{unknownLabel}</span>;
  if (tray.empty) return <span className="mj-secondary">Empty</span>;
  return (
    <span className="mj-inline">
      <span className="mj-swatch" style={{ backgroundColor: tray.colorHex ? `#${tray.colorHex}` : 'transparent' }} role="img" aria-label={tray.colorHex ? `Colour ${tray.colorHex}` : 'Unknown colour'} />
      <span>{tray.subBrand ?? tray.materialType ?? 'Unknown material'}</span>
      <span className="mj-secondary">{tray.remainPercent == null ? 'Unknown' : `${tray.remainPercent} %`}</span>
      {tray.rfid && <Tag size="sm" type="blue">RFID</Tag>}
    </span>
  );
}
