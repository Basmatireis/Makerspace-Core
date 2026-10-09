import { Button, Form, InlineNotification, PasswordInput, Stack, Tag, TextInput, Tile } from '@carbon/react';
import { useEffect, useState } from 'react';
import { useDeviceBridge } from './DeviceBridgeProvider';
import { hasEmbeddedDesktopBridge, type NfcEvent } from './device-bridge';

export function DeviceBridgeConnectionPanel() {
  const { info, error, connectDesktop, disconnect } = useDeviceBridge();
  const [baseURL, setBaseURL] = useState('http://127.0.0.1:17321');
  const [pairingKey, setPairingKey] = useState('');
  const [pending, setPending] = useState(false);
  if (hasEmbeddedDesktopBridge()) return null;

  return <Tile><Stack gap={4}>
    <div><h2>Local hardware bridge</h2><p className="section-description">Connect this browser session to the loopback Desktop Bridge. The pairing key stays in memory and is cleared on reload.</p></div>
    {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Bridge unavailable" subtitle={error.message} />}
    {info && info.platform !== 'browser' ? <>
      <div className="button-cluster"><Tag type="green">{info.platform}</Tag>{info.capabilities.map((capability) => <Tag key={capability.id} type={capability.available ? 'blue' : 'gray'}>{capability.id}: {capability.state}</Tag>)}</div>
      {info.deviceName && <p>Registered as <strong>{info.deviceName}</strong>.</p>}
      <Button kind="secondary" onClick={disconnect}>Disconnect bridge</Button>
    </> : <Form onSubmit={(event) => {
      event.preventDefault(); setPending(true);
      void connectDesktop({ baseURL, pairingKey }).then(() => setPairingKey('')).catch(() => undefined).finally(() => setPending(false));
    }}><Stack gap={4}>
      <TextInput id="desktop-bridge-url" labelText="Bridge URL" value={baseURL} onChange={(event) => setBaseURL(event.target.value)} />
      <PasswordInput id="desktop-bridge-pairing" labelText="Pairing key" autoComplete="off" value={pairingKey} onChange={(event) => setPairingKey(event.target.value)} />
      <Button type="submit" disabled={pending || pairingKey.length < 32}>{pending ? 'Connecting…' : 'Connect bridge'}</Button>
    </Stack></Form>}
  </Stack></Tile>;
}

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
