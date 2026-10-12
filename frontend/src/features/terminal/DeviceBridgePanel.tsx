import { InlineNotification } from '@carbon/react';
import { useEffect, useState } from 'react';
import { useDeviceBridge } from './DeviceBridgeProvider';
import type { NfcEvent } from './device-bridge';

export function TerminalHardwareStatus() {
  const { bridge, info } = useDeviceBridge();
  const [lastEvent, setLastEvent] = useState<NfcEvent | null>(null);
  useEffect(() => bridge.subscribeToNfc(setLastEvent), [bridge]);
  const nfc = info?.capabilities.find((capability) => capability.id === 'nfc');
  if (!nfc) return null;
  return <InlineNotification
    kind={nfc.available ? 'info' : 'warning'}
    lowContrast
    hideCloseButton
    title={nfc.available ? 'NFC reader ready' : 'NFC reader unavailable'}
    subtitle={lastEvent?.kind === 'nfc_scan' ? 'NFC tag detected. Scans do not sign in a person automatically.' : nfc.detail ?? `Reader state: ${nfc.state}`}
  />;
}
