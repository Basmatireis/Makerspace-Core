import { InlineNotification, Stack } from '@carbon/react';
import { useEffect, useState } from 'react';
import { BrandMark } from '../../app/BrandMark';
import { runKioskPairing, type KioskPairingApi, type KioskPairingState } from './pairing';

const TROUBLE_TEXT = {
  rate_limited: 'Too many requests, trying again shortly.',
  offline: 'Cannot reach Makerspace Core, trying again.',
} as const;

const clockText = (milliseconds: number) => {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Shown by a browser that is not registered as a kiosk: a pairing code that staff enter under Settings › Devices &
 * sessions › Pair device. Once claimed, the poll installs the managed-device cookie and `onPaired` continues.
 */
export function KioskPairingScreen({ api, onPaired }: { api?: KioskPairingApi; onPaired: () => void }) {
  const [state, setState] = useState<KioskPairingState>({ kind: 'starting' });
  const now = useNow(1000);
  useEffect(() => {
    const controller = new AbortController();
    void runKioskPairing({ api, signal: controller.signal, onState: setState }).then((paired) => {
      if (paired) onPaired();
    });
    return () => controller.abort();
  }, [api, onPaired]);

  const trouble =
    state.kind === 'waiting' || state.kind === 'claimed'
      ? state.trouble
      : state.kind === 'retrying'
        ? state.reason
        : undefined;
  return (
    <main className="kiosk-pairing">
      <Stack gap={6} className="kiosk-pairing__panel">
        <BrandMark kind="logo" className="kiosk-pairing__logo" />
        <h1 className="kiosk-pairing__title">This browser is not registered as a kiosk</h1>
        {state.kind === 'waiting' && (
          <>
            <p className="kiosk-pairing__code" aria-label={`Pairing code ${state.code.split('').join(' ')}`}>
              {state.code}
            </p>
            <p className="kiosk-pairing__hint">
              To register it, open Makerspace Core on a staff device and enter this code under Settings › Devices &amp;
              sessions › Pair device.
            </p>
            <p className="kiosk-pairing__small">
              The code expires in {clockText(state.expiresAt - now)}. A new one appears automatically.
            </p>
          </>
        )}
        {(state.kind === 'starting' || state.kind === 'retrying') && (
          <p className="kiosk-pairing__hint">Requesting a pairing code…</p>
        )}
        {(state.kind === 'claimed' || state.kind === 'paired') && (
          <p className="kiosk-pairing__hint">The kiosk was registered. Finishing set-up…</p>
        )}
        {state.kind === 'denied' && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Pairing is not available"
            subtitle="This network may not register kiosks. Connect the device to the makerspace network."
          />
        )}
        {trouble && (
          <p className="kiosk-pairing__small" role="status">
            {TROUBLE_TEXT[trouble]}
          </p>
        )}
      </Stack>
    </main>
  );
}
