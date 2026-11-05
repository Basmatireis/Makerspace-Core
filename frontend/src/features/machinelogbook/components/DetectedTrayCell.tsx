import { CodeSnippet, Tag } from '@carbon/react';
import type { PrinterLiveStatusTray } from '../../../api/generated/models';
import { trayIdentityDisplay } from './spoolShared';

/** Live content of a printer slot as the printer reports it (detected, never entered by staff): colour swatch, material, remaining percent, an RFID tag and, when reported, its copyable tag UID. */
export function DetectedTrayCell({
  tray,
  unknownLabel = 'Not detected',
}: {
  tray: PrinterLiveStatusTray | null;
  unknownLabel?: string;
}) {
  const identity = trayIdentityDisplay(tray);
  if (!tray) return <span className="mj-secondary">{unknownLabel}</span>;
  if (tray.empty) return <span className="mj-secondary">Empty</span>;
  return (
    <span className="mj-inline">
      <span
        className="mj-swatch"
        style={{ backgroundColor: tray.colorHex ? `#${tray.colorHex}` : 'transparent' }}
        role="img"
        aria-label={tray.colorHex ? `Reported colour ${tray.colorHex}` : 'Unknown colour'}
      />
      <span>{tray.subBrand ?? tray.materialType ?? 'Unknown material'}</span>
      <span className="mj-secondary">{tray.remainPercent == null ? 'Unknown' : `${tray.remainPercent} %`}</span>
      {tray.rfid && (
        <Tag size="sm" type="blue">
          RFID
        </Tag>
      )}
      {identity && (
        <CodeSnippet
          type="inline"
          aria-label={identity.label === 'RFID' ? 'Copy tag UID' : 'Copy spool UUID'}
          feedback="Copied"
          className="mj-inline-mono"
        >
          {identity.value}
        </CodeSnippet>
      )}
    </span>
  );
}
