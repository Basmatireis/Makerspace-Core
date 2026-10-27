/* eslint-disable react-refresh/only-export-components -- provider and hook form one bridge module */
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import {
  createPlatformDeviceBridge,
  hasEmbeddedDesktopBridge,
  type DeviceBridge,
  type DeviceInfo,
} from './device-bridge';

type DeviceBridgeContextValue = {
  bridge: DeviceBridge;
  info: DeviceInfo | null;
  error: Error | null;
};

const DeviceBridgeContext = createContext<DeviceBridgeContextValue | null>(null);

export function DeviceBridgeProvider({ children }: { children: ReactNode }) {
  // The platform shell (desktop or Android) injects its bridge; browsers use the fallback.
  const [bridge] = useState<DeviceBridge>(() => createPlatformDeviceBridge());
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let retry: number | undefined;
    let attempt = 0;
    const load = () => {
      void bridge
        .getDeviceInfo({ signal: controller.signal })
        .then((value) => {
          setInfo(value);
          setError(null);
        })
        .catch((caught: unknown) => {
          if (controller.signal.aborted) return;
          attempt += 1;
          if (hasEmbeddedDesktopBridge() && attempt < 20) {
            retry = window.setTimeout(load, 250);
            return;
          }
          setError(caught instanceof Error ? caught : new Error('Device bridge is unavailable'));
        });
    };
    load();
    return () => {
      controller.abort();
      if (retry !== undefined) window.clearTimeout(retry);
    };
  }, [bridge]);

  // Context value: consumers re-render only when the bridge, its info or its error change.
  const value = useMemo<DeviceBridgeContextValue>(() => ({ bridge, info, error }), [bridge, error, info]);

  return <DeviceBridgeContext.Provider value={value}>{children}</DeviceBridgeContext.Provider>;
}

export function useDeviceBridge(): DeviceBridgeContextValue {
  const value = useContext(DeviceBridgeContext);
  if (!value) throw new Error('useDeviceBridge must be used inside DeviceBridgeProvider');
  return value;
}
