import type { SignagePlayerHeartbeat, SignagePlayerLive, SignagePlayerManifest, SignageResolution } from '../api/generated/models';
import { isRevoked, PlayerApiError, type PlayerApi } from './api';
import { loadAsset as defaultLoadAsset, settleLimited, type AssetLoader } from './assets';
import { noCameraSource, type CameraSource } from './camera';
import { backoffMs } from './timing';
import { resolveView, type Hold, type LiveSnapshot, type PlayerView } from './view';
import { PLAYER_VERSION } from './version';

// The playing display: keeps the active revision, polls live data, sends heartbeats and publishes one snapshot per second.
// Framework-free so it runs under test with fake timers; the React layer only subscribes to snapshots.

export const LIVE_INTERVAL_MS = 10_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const MANIFEST_INTERVAL_MS = 60_000;
const UNPUBLISHED_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 120_000;
const ERROR_MEMORY_MS = 5 * 60_000;
const FIRST_LIVE_GRACE_MS = 3_000;
const PRELOAD_CONCURRENCY = 4;

export type RuntimeStatus = 'starting' | 'unpublished' | 'playing' | 'revoked';

export type RuntimeSnapshot = {
  status: RuntimeStatus;
  /** Null until a revision is active and the first live poll has finished (or the grace period passed). */
  view: PlayerView | null;
  display: { orientation: SignagePlayerManifest['display']['orientation']; resolution: SignageResolution } | null;
  /** False while the server cannot be reached; the screen shows a small dot and keeps playing. */
  online: boolean;
  revision: number | null;
};

export type RuntimeDeps = {
  api: PlayerApi;
  loadAsset?: AssetLoader;
  camera?: CameraSource;
  now?: () => number;
  playerVersion?: string;
};

type Active = { manifest: SignagePlayerManifest; urls: Map<string, string> };

export class PlayerRuntime {
  private readonly api: PlayerApi;
  private readonly loadAsset: AssetLoader;
  private readonly camera: CameraSource;
  private readonly now: () => number;
  private readonly playerVersion: string;
  private readonly listeners = new Set<() => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = true;
  private startedAt = 0;

  private active: Active | null = null;
  private unpublished = false;
  private live: LiveSnapshot | null = null;
  private lastLiveAt: number | null = null;
  private liveAttempted = false;
  private online = true;
  private hold: Hold | null = null;
  private errors: { message: string; at: number }[] = [];
  private manifestInFlight: Promise<void> | null = null;
  private manifestRetryAt = 0;
  private manifestFailures = 0;
  private revoked = false;
  private liveFailures = 0;
  private heartbeatFailures = 0;
  private snapshot: RuntimeSnapshot = { status: 'starting', view: null, display: null, online: true, revision: null };

  constructor(deps: RuntimeDeps) {
    this.api = deps.api;
    this.loadAsset = deps.loadAsset ?? defaultLoadAsset;
    this.camera = deps.camera ?? noCameraSource;
    this.now = deps.now ?? Date.now;
    this.playerVersion = deps.playerVersion ?? PLAYER_VERSION;
  }

  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly getSnapshot = () => this.snapshot;

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.startedAt = this.now();
    this.every(() => { this.publish(); return 1_000; });
    this.every(async () => { await this.refreshManifest(); return this.unpublished || this.manifestFailures > 0 ? Math.min(UNPUBLISHED_INTERVAL_MS * 2 ** this.manifestFailures, MAX_BACKOFF_MS) : MANIFEST_INTERVAL_MS; }, true);
    this.every(async () => { await this.pollLive(); return this.online ? LIVE_INTERVAL_MS : backoffMs(this.liveFailures, LIVE_INTERVAL_MS, MAX_BACKOFF_MS); }, true);
    this.every(async () => { await this.sendHeartbeat(); return this.heartbeatFailures > 0 ? backoffMs(this.heartbeatFailures, HEARTBEAT_INTERVAL_MS, MAX_BACKOFF_MS) : HEARTBEAT_INTERVAL_MS; }, true);
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearTimeout);
    this.timers.clear();
  }

  /** Runs `task` now (when `immediately`) and then again after the delay it returns, until stopped. */
  private every(task: () => number | Promise<number>, immediately = false) {
    const run = async () => {
      if (this.stopped) return;
      let delay = 1_000;
      try { delay = await task(); } catch { delay = MAX_BACKOFF_MS; }
      if (this.stopped) return;
      const timer = setTimeout(() => { this.timers.delete(timer); void run(); }, delay);
      this.timers.add(timer);
    };
    if (immediately) void run();
    else {
      const timer = setTimeout(() => { this.timers.delete(timer); void run(); }, 1_000);
      this.timers.add(timer);
    }
  }

  /** Remembers a problem for the next heartbeats (five minutes). */
  note(message: string) {
    const text = message.slice(0, 200);
    this.errors = this.errors.filter((error) => error.message !== text);
    this.errors.push({ message: text, at: this.now() });
  }

  heartbeatPayload(): SignagePlayerHeartbeat {
    const cutoff = this.now() - ERROR_MEMORY_MS;
    this.errors = this.errors.filter((error) => error.at >= cutoff).slice(-20);
    return {
      revision: this.active?.manifest.revision ?? null,
      currentRule: this.snapshot.view?.ruleId ?? null,
      currentSceneId: this.snapshot.view?.sceneId ?? null,
      playerVersion: this.playerVersion,
      // The offline cache arrives with the service worker (phase 4).
      cacheUsedBytes: 0,
      cacheQuotaBytes: 0,
      errors: this.errors.map((error) => error.message),
    };
  }

  private markRevoked() {
    this.revoked = true;
    this.stop();
    this.publish();
  }

  private async sendHeartbeat() {
    try {
      await this.api.heartbeat(this.heartbeatPayload());
      this.heartbeatFailures = 0;
    } catch (error) {
      if (isRevoked(error)) { this.markRevoked(); return; }
      this.heartbeatFailures += 1;
    }
  }

  private async pollLive() {
    try {
      const live = await this.api.live();
      this.applyLive(live);
      this.liveFailures = 0;
      this.online = true;
      // Another revision was published: fetch it right away instead of waiting for the next manifest poll.
      if (live.revision !== null && live.revision !== (this.active?.manifest.revision ?? null) && this.now() >= this.manifestRetryAt) void this.refreshManifest();
    } catch (error) {
      if (isRevoked(error)) { this.markRevoked(); return; }
      this.liveFailures += 1;
      this.online = false;
    } finally {
      this.liveAttempted = true;
      this.publish();
    }
  }

  private applyLive(live: SignagePlayerLive) {
    this.lastLiveAt = this.now();
    this.live = { machines: live.machines, announcements: live.announcements, openDays: live.openDays, events: live.events, streams: live.streams, skewMs: Date.parse(live.serverTime) - this.now() || 0 };
  }

  /** Fetches the manifest and switches to it once every asset is loaded. Concurrent calls share one run. */
  refreshManifest(): Promise<void> {
    this.manifestInFlight ??= this.fetchManifest().finally(() => { this.manifestInFlight = null; });
    return this.manifestInFlight;
  }

  private async fetchManifest() {
    try {
      const response = await this.api.manifest(this.active?.manifest.revision ?? null);
      this.unpublished = false;
      if (response.unchanged || !response.manifest) { this.manifestFailures = 0; return; }
      const manifest = response.manifest;
      if (manifest.revision === this.active?.manifest.revision) return;
      const results = await settleLimited(manifest.assets, PRELOAD_CONCURRENCY, (asset) => this.loadAsset(asset));
      const failed = results.flatMap((result, index) => (result.status === 'rejected' ? [manifest.assets[index].id] : []));
      results.forEach((result, index) => { if (result.status === 'fulfilled' && result.value === 'slow') this.note(`Video ${manifest.assets[index].id} was slow to buffer`); });
      if (failed.length > 0) {
        // Keep the current revision on screen; the next poll tries again.
        this.note(`Revision ${manifest.revision}: ${failed.length} asset(s) failed to load`);
        throw new Error('preload failed');
      }
      this.active = { manifest, urls: new Map(manifest.assets.map((asset) => [asset.id, asset.url])) };
      this.hold = null;
      this.manifestFailures = 0;
      this.manifestRetryAt = 0;
    } catch (error) {
      if (isRevoked(error)) { this.markRevoked(); return; }
      if (error instanceof PlayerApiError && error.status === 404 && error.code === 'signage_not_published') { this.unpublished = true; this.manifestFailures = 0; return; }
      // Any other 404 means the device has no display any more: it must be paired again.
      if (error instanceof PlayerApiError && error.status === 404) { this.markRevoked(); return; }
      this.manifestFailures += 1;
      this.manifestRetryAt = this.now() + backoffMs(this.manifestFailures, UNPUBLISHED_INTERVAL_MS, MAX_BACKOFF_MS);
      if (!(error instanceof Error && error.message === 'preload failed')) this.online = false;
    } finally {
      this.publish();
    }
  }

  private publish() {
    const now = this.now();
    let status: RuntimeStatus = this.revoked ? 'revoked' : this.active ? 'playing' : this.unpublished ? 'unpublished' : 'starting';
    let view: PlayerView | null = null;
    const gate = this.liveAttempted || now - this.startedAt >= FIRST_LIVE_GRACE_MS;
    if (this.active && gate && !this.revoked) {
      const urls = this.active.urls;
      const resolved = resolveView({ manifest: this.active.manifest, live: this.live, lastLiveAt: this.lastLiveAt, now, hold: this.hold, camera: this.camera, assetUrl: (id) => urls.get(id) ?? null });
      this.hold = resolved.hold;
      view = resolved.view;
    }
    if (this.revoked) status = 'revoked';
    const display = this.active ? { orientation: this.active.manifest.display.orientation, resolution: this.active.manifest.display.resolution } : null;
    this.snapshot = { status, view, display, online: this.online, revision: this.active?.manifest.revision ?? null };
    this.listeners.forEach((listener) => listener());
  }
}
