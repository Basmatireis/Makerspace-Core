export const DEVICE_BRIDGE_PROTOCOL_VERSION = 1 as const;

export type LocalCapabilityId = 'nfc' | 'camera' | 'qr' | 'barcode' | 'scale' | 'label_printer';
export type BridgePlatform = 'browser' | 'desktop';

export type DeviceCapabilityState = {
  id: LocalCapabilityId;
  available: boolean;
  state: 'ready' | 'simulated' | 'initializing' | 'disconnected' | 'unavailable' | 'unsupported' | 'error';
  detail?: string;
};

export type DeviceInfo = {
  protocolVersion: typeof DEVICE_BRIDGE_PROTOCOL_VERSION;
  bridgeVersion: string;
  platform: BridgePlatform;
  capabilities: readonly DeviceCapabilityState[];
  coreConnected: boolean;
  deviceName?: string;
};

export type ReaderMetadata = { id: string; name?: string; protocol?: string; atr?: string };

export type NfcEvent = {
  protocolVersion: typeof DEVICE_BRIDGE_PROTOCOL_VERSION;
  sequence: number;
  kind: 'nfc_scan' | 'nfc_removed';
  occurredAt: string;
  source: 'pcsc' | 'simulator';
  reader?: ReaderMetadata;
  uid?: string;
  uidFormat?: 'hex';
  duplicate?: boolean;
};

export type DeviceStateEvent = {
  protocolVersion: typeof DEVICE_BRIDGE_PROTOCOL_VERSION;
  sequence: number;
  kind: 'reader_state' | 'capability_state';
  occurredAt: string;
  source: 'pcsc' | 'simulator';
  reader?: ReaderMetadata;
  state: string;
  errorCode?: string;
};

export type DeviceBridgeEvent = NfcEvent | DeviceStateEvent;
export type Unsubscribe = () => void;

export interface DeviceBridge {
  getDeviceInfo(options?: { signal?: AbortSignal }): Promise<DeviceInfo>;
  getCapabilities(options?: { signal?: AbortSignal }): Promise<readonly DeviceCapabilityState[]>;
  scanNfc(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<NfcEvent>;
  subscribeToNfc(callback: (event: NfcEvent) => void): Unsubscribe;
  subscribe(callback: (event: DeviceBridgeEvent) => void): Unsubscribe;
  disconnect(): void;
}

export class DeviceBridgeError extends Error {
  readonly code: 'unsupported' | 'unavailable' | 'unauthorized' | 'invalid_response' | 'timeout' | 'aborted';

  constructor(code: DeviceBridgeError['code'], message: string) {
    super(message);
    this.name = 'DeviceBridgeError';
    this.code = code;
  }
}

export class BrowserDeviceBridge implements DeviceBridge {
  async getDeviceInfo(): Promise<DeviceInfo> {
    return { protocolVersion: 1, bridgeVersion: 'none', platform: 'browser', capabilities: [], coreConnected: false };
  }
  async getCapabilities(): Promise<readonly DeviceCapabilityState[]> {
    return [];
  }
  async scanNfc(): Promise<NfcEvent> {
    throw new DeviceBridgeError('unsupported', 'NFC is not available in this browser');
  }
  subscribeToNfc(): Unsubscribe {
    return () => undefined;
  }
  subscribe(): Unsubscribe {
    return () => undefined;
  }
  disconnect(): void {
    /* no connection */
  }
}

export class DesktopDeviceBridge implements DeviceBridge {
  private readonly baseURL: string;
  private readonly pairingKey: string;
  private readonly listeners = new Set<(event: DeviceBridgeEvent) => void>();
  private pollController?: AbortController;
  private latestSequence = 0;
  private reconnectDelay = 250;

  constructor(options: { baseURL: string; pairingKey: string }) {
    const parsed = new URL(options.baseURL);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      !isLoopback(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new DeviceBridgeError('unavailable', 'Desktop bridge URL must be an HTTP(S) loopback URL');
    }
    if (options.pairingKey.length < 32)
      throw new DeviceBridgeError('unauthorized', 'Desktop bridge pairing key is invalid');
    this.baseURL = parsed.toString().replace(/\/$/, '');
    this.pairingKey = options.pairingKey;
  }

  async getDeviceInfo(options: { signal?: AbortSignal } = {}): Promise<DeviceInfo> {
    const raw = await this.request<unknown>('/v1/info', options.signal);
    const info = normalizeDeviceInfo(raw);
    this.latestSequence = readNumber(raw, 'latestSequence');
    return info;
  }
  async getCapabilities(options: { signal?: AbortSignal } = {}): Promise<readonly DeviceCapabilityState[]> {
    return (await this.getDeviceInfo(options)).capabilities;
  }
  scanNfc(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<NfcEvent> {
    return waitForNfc(this, options);
  }
  subscribeToNfc(callback: (event: NfcEvent) => void): Unsubscribe {
    return this.subscribe((event) => {
      if (event.kind === 'nfc_scan' || event.kind === 'nfc_removed') callback(event);
    });
  }
  subscribe(callback: (event: DeviceBridgeEvent) => void): Unsubscribe {
    this.listeners.add(callback);
    void this.ensurePolling();
    return () => {
      this.listeners.delete(callback);
      if (this.listeners.size === 0) this.stopPolling();
    };
  }
  disconnect(): void {
    this.listeners.clear();
    this.stopPolling();
  }

  private async ensurePolling() {
    if (this.pollController || this.listeners.size === 0) return;
    this.pollController = new AbortController();
    const signal = this.pollController.signal;
    try {
      await this.getDeviceInfo({ signal });
      while (!signal.aborted && this.listeners.size > 0) {
        try {
          const page = await this.request<unknown>(`/v1/events?after=${this.latestSequence}&wait=25s`, signal);
          const events = normalizeEventPage(page);
          this.reconnectDelay = 250;
          for (const event of events) {
            this.latestSequence = Math.max(this.latestSequence, event.sequence);
            for (const listener of [...this.listeners]) listener(event);
          }
        } catch {
          if (signal.aborted) break;
          await abortableDelay(this.reconnectDelay, signal);
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5_000);
        }
      }
    } finally {
      if (this.pollController?.signal === signal) this.pollController = undefined;
    }
  }
  private stopPolling() {
    this.pollController?.abort();
    this.pollController = undefined;
  }
  private async request<T>(path: string, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseURL}${path}`, {
        headers: { Accept: 'application/json', Authorization: `Pairing ${this.pairingKey}` },
        cache: 'no-store',
        mode: 'cors',
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw new DeviceBridgeError('aborted', 'Device bridge request was cancelled');
      throw new DeviceBridgeError(
        'unavailable',
        error instanceof Error ? error.message : 'Device bridge is unavailable',
      );
    }
    if (response.status === 401 || response.status === 403)
      throw new DeviceBridgeError('unauthorized', 'Device bridge pairing was rejected');
    if (!response.ok) throw new DeviceBridgeError('unavailable', `Device bridge returned status ${response.status}`);
    return response.json() as Promise<T>;
  }
}

type EmbeddedDesktopBridgeConfig = { baseURL: string; pairingKey: string };

declare global {
  interface Window {
    makerspaceDesktopBridge?: EmbeddedDesktopBridgeConfig;
  }
}

export function createPlatformDeviceBridge(): DeviceBridge {
  if (window.makerspaceDesktopBridge) return new DesktopDeviceBridge(window.makerspaceDesktopBridge);
  return new BrowserDeviceBridge();
}

export function hasEmbeddedDesktopBridge(): boolean {
  return window.makerspaceDesktopBridge !== undefined;
}

function normalizeDeviceInfo(value: unknown): DeviceInfo {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 1 ||
    !['desktop', 'browser'].includes(String(value.platform)) ||
    !Array.isArray(value.capabilities)
  ) {
    throw new DeviceBridgeError('invalid_response', 'Device bridge returned invalid device information');
  }
  return {
    protocolVersion: 1,
    bridgeVersion: String(value.bridgeVersion ?? ''),
    platform: value.platform as BridgePlatform,
    capabilities: value.capabilities.map(normalizeCapability),
    coreConnected: Boolean(value.coreConnected),
    ...(typeof value.deviceName === 'string' && value.deviceName ? { deviceName: value.deviceName } : {}),
  };
}

function normalizeCapability(value: unknown): DeviceCapabilityState {
  if (
    !isRecord(value) ||
    !['nfc', 'camera', 'qr', 'barcode', 'scale', 'label_printer'].includes(String(value.id)) ||
    typeof value.available !== 'boolean' ||
    typeof value.state !== 'string'
  ) {
    throw new DeviceBridgeError('invalid_response', 'Device bridge returned an invalid capability');
  }
  return {
    id: value.id as LocalCapabilityId,
    available: value.available,
    state: value.state as DeviceCapabilityState['state'],
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
  };
}

function normalizeEventPage(value: unknown): DeviceBridgeEvent[] {
  if (!isRecord(value) || !Array.isArray(value.events))
    throw new DeviceBridgeError('invalid_response', 'Device bridge returned an invalid event page');
  return value.events.map(normalizeEvent);
}

function normalizeEvent(value: unknown): DeviceBridgeEvent {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 1 ||
    !Number.isSafeInteger(value.sequence) ||
    typeof value.occurredAt !== 'string' ||
    !['pcsc', 'simulator'].includes(String(value.source))
  ) {
    throw new DeviceBridgeError('invalid_response', 'Device bridge returned an invalid event');
  }
  const reader =
    isRecord(value.reader) && typeof value.reader.id === 'string'
      ? {
          id: value.reader.id,
          ...(typeof value.reader.name === 'string' ? { name: value.reader.name } : {}),
          ...(typeof value.reader.protocol === 'string' ? { protocol: value.reader.protocol } : {}),
          ...(typeof value.reader.atr === 'string' ? { atr: value.reader.atr } : {}),
        }
      : undefined;
  if (value.kind === 'nfc_scan') {
    if (!isRecord(value.nfc) || typeof value.nfc.uid !== 'string' || !/^[0-9A-F]{2,64}$/.test(value.nfc.uid))
      throw new DeviceBridgeError('invalid_response', 'Device bridge returned an invalid NFC scan');
    return {
      protocolVersion: 1,
      sequence: value.sequence as number,
      kind: 'nfc_scan',
      occurredAt: value.occurredAt,
      source: value.source as NfcEvent['source'],
      reader,
      uid: value.nfc.uid,
      uidFormat: 'hex',
      duplicate: value.duplicate === true,
    };
  }
  if (value.kind === 'nfc_removed')
    return {
      protocolVersion: 1,
      sequence: value.sequence as number,
      kind: 'nfc_removed',
      occurredAt: value.occurredAt,
      source: value.source as NfcEvent['source'],
      reader,
    };
  if ((value.kind === 'reader_state' || value.kind === 'capability_state') && typeof value.state === 'string') {
    return {
      protocolVersion: 1,
      sequence: value.sequence as number,
      kind: value.kind,
      occurredAt: value.occurredAt,
      source: value.source as DeviceStateEvent['source'],
      reader,
      state: value.state,
      ...(typeof value.errorCode === 'string' ? { errorCode: value.errorCode } : {}),
    };
  }
  throw new DeviceBridgeError('invalid_response', 'Device bridge returned an unknown event type');
}

function waitForNfc(bridge: DeviceBridge, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<NfcEvent> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DeviceBridgeError('aborted', 'NFC scan was cancelled'));
      return;
    }
    let timer = 0;
    const unsubscribe = bridge.subscribeToNfc((event) => {
      if (event.kind !== 'nfc_scan' || event.duplicate) return;
      cleanup();
      resolve(event);
    });
    const abort = () => {
      cleanup();
      reject(new DeviceBridgeError('aborted', 'NFC scan was cancelled'));
    };
    const cleanup = () => {
      unsubscribe();
      options.signal?.removeEventListener('abort', abort);
      window.clearTimeout(timer);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    timer = window.setTimeout(() => {
      cleanup();
      reject(new DeviceBridgeError('timeout', 'No NFC tag was scanned before the request timed out'));
    }, options.timeoutMs ?? 30_000);
  });
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}
function readNumber(value: unknown, key: string): number {
  if (!isRecord(value) || !Number.isSafeInteger(value[key]))
    throw new DeviceBridgeError('invalid_response', `Device bridge response is missing ${key}`);
  return value[key] as number;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
