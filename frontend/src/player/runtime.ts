import type {
  SignagePlayerHeartbeat,
  SignagePlayerLive,
  SignagePlayerManifest,
  SignageResolution,
} from '../api/generated/models';
import { isRevoked, PlayerApiError, type PlayerApi } from './api';
import { loadAsset as defaultLoadAsset, settleLimited, type AssetLoader } from './assets';
import { CacheQuotaError, createPlayerStore, type PersistedLive, type PlayerStore } from './cache';
import type { CameraSource } from './camera';
import { CameraManager } from './cameraManager';
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
/** Persisted announcements, open days and events older than this are not shown after a restart. */
export const PERSISTED_LIVE_MAX_AGE_MS = 24 * 3_600_000;
/** An unchanged live payload is written to storage at most this often (kind to SD cards). */
const LIVE_SAVE_INTERVAL_MS = 5 * 60_000;

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
  /** The offline cache; `null` (no Cache Storage) falls back to in-memory preloading. Defaults to the browser's. */
  store?: PlayerStore | null;
  camera?: CameraSource;
  now?: () => number;
  playerVersion?: string;
};

type Active = { manifest: SignagePlayerManifest; urls: Map<string, string> };

export class PlayerRuntime {
  private readonly api: PlayerApi;
  private readonly loadAsset: AssetLoader;
  private readonly store: PlayerStore | null;
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
  /** The playing loops (live, heartbeat) start once the manifest call proved the device has a credential. */
  private loopsStarted = false;
  private cacheUsedBytes = 0;
  private cacheQuotaBytes = 0;
  private savedLive: { key: string; at: number } | null = null;
  private liveFailures = 0;
  private heartbeatFailures = 0;
  private snapshot: RuntimeSnapshot = { status: 'starting', view: null, display: null, online: true, revision: null };

  constructor(deps: RuntimeDeps) {
    this.api = deps.api;
    this.loadAsset = deps.loadAsset ?? defaultLoadAsset;
    this.store = deps.store === undefined ? createPlayerStore() : deps.store;
    this.camera = deps.camera ?? new CameraManager();
    this.camera.setErrorSink?.((message) => this.note(message));
    this.camera.subscribe?.(() => {
      if (!this.stopped) this.publish();
    });
    this.now = deps.now ?? Date.now;
    this.playerVersion = deps.playerVersion ?? PLAYER_VERSION;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.snapshot;

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.loopsStarted = false;
    this.startedAt = this.now();
    this.every(() => {
      this.publish();
      return 1_000;
    });
    void this.begin();
  }

  /** Restores the last revision from the cache (so a cold start offline plays), then asks the server. */
  private async begin() {
    void this.store?.requestPersistence();
    await this.restore();
    if (this.stopped) return;
    this.every(async () => {
      await this.refreshManifest();
      return this.unpublished || this.manifestFailures > 0
        ? Math.min(UNPUBLISHED_INTERVAL_MS * 2 ** this.manifestFailures, MAX_BACKOFF_MS)
        : MANIFEST_INTERVAL_MS;
    }, true);
    // A restored revision proves the device was paired. Without one the loops wait for the first answer of the manifest call:
    // before that the device may have no credential and live/heartbeat would only produce 401s.
    if (this.active) this.startPlayingLoops();
  }

  private startPlayingLoops() {
    if (this.loopsStarted || this.stopped || this.revoked) return;
    this.loopsStarted = true;
    this.every(async () => {
      await this.pollLive();
      return this.online ? LIVE_INTERVAL_MS : backoffMs(this.liveFailures, LIVE_INTERVAL_MS, MAX_BACKOFF_MS);
    }, true);
    this.every(async () => {
      await this.sendHeartbeat();
      return this.heartbeatFailures > 0
        ? backoffMs(this.heartbeatFailures, HEARTBEAT_INTERVAL_MS, MAX_BACKOFF_MS)
        : HEARTBEAT_INTERVAL_MS;
    }, true);
  }

  private async restore() {
    if (!this.store) return;
    try {
      const manifest = await this.store.loadManifest();
      if (!manifest || !(await this.store.hasAll(manifest.assets))) return;
      this.active = { manifest, urls: new Map(manifest.assets.map((asset) => [asset.id, asset.url])) };
      const saved = await this.store.loadLive();
      if (saved && this.now() - saved.savedAt <= PERSISTED_LIVE_MAX_AGE_MS) {
        // Machines are never restored: their status is only fresh when polled, so the view treats live data as unavailable.
        this.live = {
          machines: [],
          announcements: saved.announcements,
          openDays: saved.openDays,
          events: saved.events,
          streams: [],
          skewMs: saved.skewMs,
        };
      }
    } catch {
      /* An unreadable cache just means a normal start. */
    }
    this.publish();
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.camera.dispose?.();
  }

  /** Runs `task` now (when `immediately`) and then again after the delay it returns, until stopped. */
  private every(task: () => number | Promise<number>, immediately = false) {
    const run = async () => {
      if (this.stopped) return;
      let delay: number;
      try {
        delay = await task();
      } catch {
        delay = MAX_BACKOFF_MS;
      }
      if (this.stopped) return;
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        void run();
      }, delay);
      this.timers.add(timer);
    };
    if (immediately) void run();
    else {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        void run();
      }, 1_000);
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
      cacheUsedBytes: this.cacheUsedBytes,
      cacheQuotaBytes: this.cacheQuotaBytes,
      errors: this.errors.map((error) => error.message),
    };
  }

  private markRevoked() {
    this.revoked = true;
    this.stop();
    // A display that is no longer paired must not keep its content.
    void this.store?.clear().catch(() => undefined);
    this.publish();
  }

  private async sendHeartbeat() {
    try {
      const use = await this.store?.usage();
      if (use) {
        this.cacheUsedBytes = use.usedBytes;
        this.cacheQuotaBytes = use.quotaBytes;
      }
      await this.api.heartbeat(this.heartbeatPayload());
      this.heartbeatFailures = 0;
    } catch (error) {
      if (isRevoked(error)) {
        this.markRevoked();
        return;
      }
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
      if (
        live.revision !== null &&
        live.revision !== (this.active?.manifest.revision ?? null) &&
        this.now() >= this.manifestRetryAt
      )
        void this.refreshManifest();
    } catch (error) {
      if (isRevoked(error)) {
        this.markRevoked();
        return;
      }
      this.liveFailures += 1;
      this.online = false;
    } finally {
      this.liveAttempted = true;
      this.publish();
    }
  }

  private applyLive(live: SignagePlayerLive) {
    this.lastLiveAt = this.now();
    this.live = {
      machines: live.machines,
      announcements: live.announcements,
      openDays: live.openDays,
      events: live.events,
      streams: live.streams,
      skewMs: Date.parse(live.serverTime) - this.now() || 0,
    };
    this.camera.setStreams?.(live.streams);
    this.persistLive(this.live);
  }

  /** Keeps the parts of live data that may outlive a restart (never machines). */
  private persistLive(live: LiveSnapshot) {
    if (!this.store) return;
    const key = JSON.stringify([live.announcements, live.openDays, live.events]);
    const now = this.now();
    if (this.savedLive && this.savedLive.key === key && now - this.savedLive.at < LIVE_SAVE_INTERVAL_MS) return;
    this.savedLive = { key, at: now };
    const payload: PersistedLive = {
      savedAt: now,
      skewMs: live.skewMs,
      announcements: live.announcements,
      openDays: live.openDays,
      events: live.events,
    };
    void this.store.saveLive(payload).catch(() => undefined);
  }

  /** Fetches the manifest and switches to it once every asset is loaded. Concurrent calls share one run. */
  refreshManifest(): Promise<void> {
    this.manifestInFlight ??= this.fetchManifest().finally(() => {
      this.manifestInFlight = null;
    });
    return this.manifestInFlight;
  }

  private async fetchManifest() {
    try {
      const response = await this.api.manifest(this.active?.manifest.revision ?? null);
      this.unpublished = false;
      this.startPlayingLoops();
      if (response.unchanged || !response.manifest) {
        this.manifestFailures = 0;
        return;
      }
      const manifest = response.manifest;
      if (manifest.revision === this.active?.manifest.revision) return;
      await this.cacheRevision(manifest);
      this.active = { manifest, urls: new Map(manifest.assets.map((asset) => [asset.id, asset.url])) };
      this.hold = null;
      this.manifestFailures = 0;
      this.manifestRetryAt = 0;
      // The new revision is on screen and persisted: assets only the old one used can go.
      await this.store?.retain(manifest.assets).catch(() => undefined);
    } catch (error) {
      if (isRevoked(error)) {
        this.markRevoked();
        return;
      }
      if (error instanceof PlayerApiError && error.status === 404 && error.code === 'signage_not_published') {
        this.unpublished = true;
        this.startPlayingLoops();
        this.manifestFailures = 0;
        return;
      }
      // Any other 404 means the device has no display any more: it must be paired again.
      if (error instanceof PlayerApiError && error.status === 404) {
        this.markRevoked();
        return;
      }
      this.manifestFailures += 1;
      this.manifestRetryAt = this.now() + backoffMs(this.manifestFailures, UNPUBLISHED_INTERVAL_MS, MAX_BACKOFF_MS);
      if (!(error instanceof Error && error.message === 'preload failed')) this.online = false;
    } finally {
      this.publish();
    }
  }

  /** Makes every asset of the manifest available (cached on disk, or preloaded in memory without Cache Storage); throws when it cannot. */
  private async cacheRevision(manifest: SignagePlayerManifest) {
    const store = this.store;
    if (!store) {
      const results = await settleLimited(manifest.assets, PRELOAD_CONCURRENCY, (asset) => this.loadAsset(asset));
      const failed = results.flatMap((result, index) =>
        result.status === 'rejected' ? [manifest.assets[index].id] : [],
      );
      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value === 'slow')
          this.note(`Video ${manifest.assets[index].id} was slow to buffer`);
      });
      if (failed.length > 0) {
        // Keep the current revision on screen; the next poll tries again.
        this.note(`Revision ${manifest.revision}: ${failed.length} asset(s) failed to load`);
        throw new Error('preload failed');
      }
      return;
    }
    try {
      await store.assertFits(manifest.assets);
      const results = await settleLimited(manifest.assets, PRELOAD_CONCURRENCY, (asset) => store.ensureAsset(asset));
      const quota = results.find((result) => result.status === 'rejected' && result.reason instanceof CacheQuotaError);
      if (quota?.status === 'rejected') throw quota.reason;
      const failed = results.filter((result) => result.status === 'rejected').length;
      if (failed > 0) {
        this.note(`Revision ${manifest.revision}: ${failed} asset(s) failed to download`);
        throw new Error('preload failed');
      }
      // Persisted before it goes on screen, so a restart without network plays this revision and not the one before.
      await store.saveManifest(manifest);
    } catch (error) {
      if (error instanceof CacheQuotaError || (error instanceof DOMException && error.name === 'QuotaExceededError')) {
        this.note(`Revision ${manifest.revision} not activated: ${error.message}`.slice(0, 200));
        // Drop what the refused revision already downloaded; the active one keeps playing.
        await store.retain(this.active?.manifest.assets ?? []).catch(() => undefined);
        throw new Error('preload failed', { cause: error });
      }
      throw error;
    }
  }

  private publish() {
    const now = this.now();
    let status: RuntimeStatus = this.revoked
      ? 'revoked'
      : this.active
        ? 'playing'
        : this.unpublished
          ? 'unpublished'
          : 'starting';
    let view: PlayerView | null = null;
    const gate = this.liveAttempted || now - this.startedAt >= FIRST_LIVE_GRACE_MS;
    if (this.active && gate && !this.revoked) {
      const urls = this.active.urls;
      const resolved = resolveView({
        manifest: this.active.manifest,
        live: this.live,
        lastLiveAt: this.lastLiveAt,
        now,
        hold: this.hold,
        camera: this.camera,
        assetUrl: (id) => urls.get(id) ?? null,
      });
      this.hold = resolved.hold;
      view = resolved.view;
    }
    if (this.revoked) status = 'revoked';
    const display = this.active
      ? { orientation: this.active.manifest.display.orientation, resolution: this.active.manifest.display.resolution }
      : null;
    this.snapshot = { status, view, display, online: this.online, revision: this.active?.manifest.revision ?? null };
    this.listeners.forEach((listener) => listener());
  }
}
