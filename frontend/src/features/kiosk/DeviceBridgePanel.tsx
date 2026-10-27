import { InlineNotification, Tag } from '@carbon/react';
import { useDeviceBridge } from './DeviceBridgeProvider';

// A card scan is only ever acknowledged: no scan signs anybody in.
export function KioskHardwareStatus() {
  const { info } = useDeviceBridge();
  const nfc = info?.capabilities.find((capability) => capability.id === 'nfc');
  if (!nfc) return null;
  if (!nfc.available)
    return (
      <InlineNotification
        kind="warning"
        lowContrast
        hideCloseButton
        title="Card reader unavailable"
        subtitle="Use your PIN or password."
      />
    );
  return (
    <div className="tablet-nfc">
      <Tag type="green" size="md">
        Card reader ready
      </Tag>
      <span>Card scans are recognised but do not sign you in yet.</span>
    </div>
  );
}
