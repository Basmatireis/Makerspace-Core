/* eslint-disable react-refresh/only-export-components -- provider and hook form one bridge module */
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import {
  BrowserDeviceBridge, createPlatformDeviceBridge, DesktopDeviceBridge, type DeviceBridge, type DeviceInfo,
} from './device-bridge';

type DeviceBridgeContextValue = {
  bridge: DeviceBridge;
  info: DeviceInfo | null;
  error: Error | null;
  connectDesktop(options: { baseURL: string; pairingKey: string }): Promise<void>;
  disconnect(): void;
};

const DeviceBridgeContext = createContext<DeviceBridgeContextValue | null>(null);

export function DeviceBridgeProvider({ children }: { children: ReactNode }) {
  const [bridge, setBridge] = useState<DeviceBridge>(() => createPlatformDeviceBridge());
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void bridge.getDeviceInfo({ signal: controller.signal }).then((value) => {
      setInfo(value);
      setError(null);
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught : new Error('Device bridge is unavailable'));
    });
    return () => controller.abort();
  }, [bridge]);

  const value = useMemo<DeviceBridgeContextValue>(() => ({
    bridge,
    info,
    error,
    async connectDesktop(options) {
      const candidate = new DesktopDeviceBridge(options);
      try {
        const deviceInfo = await candidate.getDeviceInfo();
        bridge.disconnect();
        setBridge(candidate);
        setInfo(deviceInfo);
        setError(null);
      } catch (caught) {
        candidate.disconnect();
        const normalized = caught instanceof Error ? caught : new Error('Device bridge is unavailable');
        setError(normalized);
        throw normalized;
      }
    },
    disconnect() {
      bridge.disconnect();
      const fallback = new BrowserDeviceBridge();
      setBridge(fallback);
      setInfo(null);
      setError(null);
    },
  }), [bridge, error, info]);

  return <DeviceBridgeContext.Provider value={value}>{children}</DeviceBridgeContext.Provider>;
}

export function useDeviceBridge(): DeviceBridgeContextValue {
  const value = useContext(DeviceBridgeContext);
  if (!value) throw new Error('useDeviceBridge must be used inside DeviceBridgeProvider');
  return value;
}
