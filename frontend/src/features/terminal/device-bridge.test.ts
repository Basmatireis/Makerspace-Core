import { describe, expect, it, vi } from 'vitest';
import {
  AndroidDeviceBridge, BrowserDeviceBridge, DesktopDeviceBridge, DeviceBridgeError,
} from './device-bridge';

const info = {
  protocolVersion: 1,
  bridgeVersion: '1.0.0',
  platform: 'desktop',
  coreConnected: true,
  latestSequence: 3,
  capabilities: [{ id: 'nfc', available: true, state: 'ready' }],
};

describe('Device Bridge contract', () => {
  it('keeps ordinary browsers usable and returns a clear unsupported error', async () => {
    const bridge = new BrowserDeviceBridge();
    await expect(bridge.getCapabilities()).resolves.toEqual([]);
    await expect(bridge.scanNfc()).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('accepts only loopback Desktop Bridge URLs and authenticates every request', async () => {
    expect(() => new DesktopDeviceBridge({ baseURL: 'https://attacker.example', pairingKey: 'a'.repeat(32) })).toThrow(DeviceBridgeError);
    const fetchMock = vi.fn().mockResolvedValue(Response.json(info));
    vi.stubGlobal('fetch', fetchMock);
    const bridge = new DesktopDeviceBridge({ baseURL: 'http://127.0.0.1:17321', pairingKey: 'a'.repeat(32) });
    await expect(bridge.getCapabilities()).resolves.toEqual([{ id: 'nfc', available: true, state: 'ready' }]);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:17321/v1/info', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Pairing ${'a'.repeat(32)}` }),
    }));
    vi.unstubAllGlobals();
  });

  it('normalizes desktop NFC events and ignores duplicates for one-shot scans', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      calls += 1;
      if (url.endsWith('/v1/info')) return Response.json(info);
      if (calls === 2) return Response.json({ events: [
        { protocolVersion: 1, sequence: 4, kind: 'nfc_scan', occurredAt: '2026-01-01T00:00:00Z', source: 'simulator', nfc: { uid: '04A7', uidFormat: 'hex' }, duplicate: true },
        { protocolVersion: 1, sequence: 5, kind: 'nfc_scan', occurredAt: '2026-01-01T00:00:01Z', source: 'simulator', nfc: { uid: '04B8', uidFormat: 'hex' } },
      ], nextSequence: 5 });
      return new Promise<Response>((_, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    }));
    const bridge = new DesktopDeviceBridge({ baseURL: 'http://localhost:17321', pairingKey: 'b'.repeat(32) });
    await expect(bridge.scanNfc({ timeoutMs: 1_000 })).resolves.toMatchObject({ kind: 'nfc_scan', uid: '04B8', duplicate: false });
    bridge.disconnect();
    vi.unstubAllGlobals();
  });

  it('uses the narrow Android message transport and the same event format', async () => {
    let request = '';
    const bridge = new AndroidDeviceBridge({ postMessage: (message) => { request = message; } });
    const pending = bridge.getDeviceInfo();
    const id = (JSON.parse(request) as { id: string }).id;
    window.dispatchEvent(new CustomEvent('makerspace:device-bridge-message', { detail: {
      id,
      result: { ...info, platform: 'android' },
    } }));
    await expect(pending).resolves.toMatchObject({ platform: 'android' });
    const received: string[] = [];
    const unsubscribe = bridge.subscribeToNfc((event) => { if (event.uid) received.push(event.uid); });
    window.dispatchEvent(new CustomEvent('makerspace:device-bridge-message', { detail: { event: {
      protocolVersion: 1, sequence: 9, kind: 'nfc_scan', occurredAt: '2026-01-01T00:00:00Z', source: 'android', nfc: { uid: '04A731', uidFormat: 'hex' },
    } } }));
    expect(received).toEqual(['04A731']);
    unsubscribe();
    bridge.disconnect();
  });
});
