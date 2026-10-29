/* eslint-disable react-refresh/only-export-components -- the manager and the tile it renders belong together */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { RenderMachine } from '../features/signage/render/types';
import type { CameraSource, LiveStreams } from './camera';
import { connectStream, StreamError, type Connection, type Feed, type StreamEnv, type StreamOffer } from './stream';
import { jitteredBackoffMs } from './timing';

// One connection per machine, shared by every zone that shows it. A connection exists only while a camera tile is on
// screen (so go2rtc can idle the printer). The stream path comes from the live data. Lost connections are retried with
// exponential backoff; Core closing with 4403 (not allowed) or 4404 (camera gone) stops retrying until a later live poll
// lists the stream again.

/** A camera that is not showing a picture within this time counts as unavailable (the widget shows its fallback). */
export const STREAM_DEADLINE_MS = 8_000;
/** A hidden camera stays connected this long, so scene changes and alternating cameras do not reconnect every time. */
export const IDLE_GRACE_MS = 15_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

type Entry = {
  machineId: string;
  offer: StreamOffer;
  /** Camera tiles currently showing the machine. */
  refs: number;
  /** pending: not connected yet; connecting; live: a picture is available; failed: fallback shown until the next try. */
  phase: 'pending' | 'connecting' | 'live' | 'failed';
  conn: Connection | null;
  abort: AbortController | null;
  /** Core closed the stream as forbidden or gone: connecting again waits for the next live poll that lists it. */
  denied: boolean;
  failures: number;
  quick: number;
  /** Why the last attempt failed (reported when the deadline passes). */
  lastReason?: string;
  deadline?: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
  revive?: ReturnType<typeof setTimeout>;
  grace?: ReturnType<typeof setTimeout>;
};

type Options = { env?: StreamEnv };

export class CameraManager implements CameraSource {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private report: (message: string) => void = () => undefined;

  constructor(private readonly options: Options = {}) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  setErrorSink(sink: (message: string) => void) {
    this.report = sink;
  }
  private notify() {
    this.listeners.forEach((listener) => listener());
  }

  hasStream(machineId: string) {
    const entry = this.entries.get(machineId);
    return entry !== undefined && entry.phase !== 'failed';
  }

  /** The shared picture once the connection is up. */
  feed(machineId: string): Feed | null {
    const entry = this.entries.get(machineId);
    return entry?.phase === 'live' && entry.conn ? entry.conn.feed : null;
  }

  view(machine: RenderMachine) {
    return <CameraVideo manager={this} machineId={machine.machineId} />;
  }

  /** A tile shows the machine: connect if needed. The returned function releases it; the connection closes after a grace period. */
  acquire(machineId: string): () => void {
    const entry = this.entries.get(machineId);
    if (!entry) return () => undefined;
    entry.refs += 1;
    clearTimeout(entry.grace);
    this.begin(entry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.refs -= 1;
      if (entry.refs === 0 && this.entries.get(machineId) === entry) {
        entry.grace = setTimeout(() => {
          this.stop(entry);
          if (entry.phase !== 'failed') entry.phase = 'pending';
        }, IDLE_GRACE_MS);
      }
    };
  }

  setStreams(streams: LiveStreams) {
    let changed = false;
    const offered = new Set(streams.map((stream) => stream.machineId));
    for (const entry of [...this.entries.values()]) {
      if (!offered.has(entry.machineId)) {
        this.remove(entry);
        changed = true;
      }
    }
    for (const stream of streams) {
      const offer: StreamOffer = { path: stream.path };
      const entry = this.entries.get(stream.machineId);
      if (!entry) {
        this.entries.set(stream.machineId, {
          machineId: stream.machineId,
          offer,
          refs: 0,
          phase: 'pending',
          conn: null,
          abort: null,
          denied: false,
          failures: 0,
          quick: 0,
        });
        changed = true;
        continue;
      }
      const moved = entry.offer.path !== offer.path;
      entry.offer = offer;
      if (entry.denied) {
        // The live poll lists the stream again: Core allows it now, so try once more.
        entry.denied = false;
        entry.failures = 0;
        entry.phase = 'pending';
        changed = true;
        this.begin(entry);
      } else if (moved && entry.phase !== 'failed') {
        this.stop(entry);
        entry.phase = 'pending';
        this.begin(entry);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  dispose() {
    for (const entry of [...this.entries.values()]) this.remove(entry);
    this.notify();
  }

  private begin(entry: Entry) {
    if (entry.refs === 0 || entry.conn || entry.abort || entry.retry || entry.phase === 'failed' || entry.denied)
      return;
    entry.phase = 'connecting';
    entry.deadline ??= setTimeout(() => this.fail(entry), STREAM_DEADLINE_MS);
    const abort = new AbortController();
    entry.abort = abort;
    connectStream(entry.offer, this.options.env ?? {}, abort.signal).then(
      (conn) => {
        if (entry.abort !== abort || abort.signal.aborted) {
          conn.close();
          return;
        }
        entry.abort = null;
        entry.conn = conn;
        entry.phase = 'live';
        entry.failures = 0;
        entry.quick = 0;
        clearTimeout(entry.deadline);
        entry.deadline = undefined;
        void conn.closed.then((error) => {
          if (entry.conn === conn) this.lost(entry, error);
        });
        this.notify();
      },
      (error: unknown) => {
        if (entry.abort !== abort || abort.signal.aborted) return;
        entry.abort = null;
        this.lost(entry, error instanceof StreamError ? error : new StreamError('closed', 'connection error'));
      },
    );
  }

  /** The connection ended or could not be made: try again shortly until the deadline turns it into a failure. */
  private lost(entry: Entry, error: StreamError) {
    const wasLive = entry.phase === 'live';
    entry.conn?.close();
    entry.conn = null;
    entry.abort = null;
    if (entry.phase === 'failed') return;
    if (error.final) {
      this.deny(entry, error.message);
      return;
    }
    entry.phase = 'connecting';
    entry.lastReason = error.message;
    entry.deadline ??= setTimeout(() => this.fail(entry), STREAM_DEADLINE_MS);
    if (wasLive) this.notify();
    entry.retry = setTimeout(
      () => {
        entry.retry = undefined;
        this.begin(entry);
      },
      jitteredBackoffMs(entry.quick, RETRY_BASE_MS, RETRY_MAX_MS),
    );
    entry.quick += 1;
  }

  /** Core said the viewer may not watch (any more) or the camera is gone: show the fallback until the next live poll lists it. */
  private deny(entry: Entry, reason: string) {
    this.stop(entry);
    clearTimeout(entry.revive);
    entry.revive = undefined;
    entry.phase = 'failed';
    entry.denied = true;
    this.report(`Camera ${entry.machineId.slice(0, 8)} unavailable: ${reason}`);
    this.notify();
  }

  private fail(entry: Entry) {
    const reason = entry.lastReason ?? 'no picture within 8 seconds';
    this.stop(entry);
    entry.phase = 'failed';
    entry.failures += 1;
    this.report(`Camera ${entry.machineId.slice(0, 8)} unavailable: ${reason}`);
    entry.revive = setTimeout(
      () => {
        entry.revive = undefined;
        entry.phase = 'pending';
        entry.quick = 0;
        this.notify(); // the tile appears again and connects
      },
      jitteredBackoffMs(entry.failures - 1, RETRY_BASE_MS, RETRY_MAX_MS),
    );
    this.notify();
  }

  private stop(entry: Entry) {
    clearTimeout(entry.deadline);
    entry.deadline = undefined;
    clearTimeout(entry.retry);
    entry.retry = undefined;
    entry.abort?.abort();
    entry.abort = null;
    entry.conn?.close();
    entry.conn = null;
    entry.lastReason = undefined;
  }

  private remove(entry: Entry) {
    clearTimeout(entry.revive);
    clearTimeout(entry.grace);
    this.stop(entry);
    this.entries.delete(entry.machineId);
  }
}

function CameraVideo({ manager, machineId }: { manager: CameraManager; machineId: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const feed = useSyncExternalStore(manager.subscribe, () => manager.feed(machineId));
  useEffect(() => manager.acquire(machineId), [manager, machineId]);
  useEffect(() => {
    const element = video.current;
    return element && feed ? feed.attach(element) : undefined;
  }, [feed]);
  return <video ref={video} className="sg-camera__video" muted playsInline autoPlay aria-hidden="true" />;
}
