import type { CameraSource, LiveStreams } from './camera';
import type { CameraManager } from './cameraManager';

// The MSE camera code (cameraManager.tsx and stream.ts) is only needed once Core offers a stream, which it does only for
// a published scene with a camera widget. It is loaded then, so the player's initial JavaScript stays within its budget
// (the build lists the chunk in the service worker's precache, so it also loads offline).

/** A camera source that loads the manager on the first non-empty stream offer. Until then no machine has a stream. */
export class LazyCameraSource implements CameraSource {
  private manager: CameraManager | null = null;
  private loading = false;
  private streams: LiveStreams = [];
  private readonly listeners = new Set<() => void>();
  private report: (message: string) => void = () => undefined;

  hasStream(machineId: string) {
    return this.manager?.hasStream(machineId) ?? false;
  }
  view(machine: Parameters<CameraSource['view']>[0]) {
    return this.manager?.view(machine) ?? null;
  }
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  setErrorSink(sink: (message: string) => void) {
    this.report = sink;
    this.manager?.setErrorSink(sink);
  }
  setStreams(streams: LiveStreams) {
    this.streams = streams;
    if (this.manager) this.manager.setStreams(streams);
    else if (streams.length > 0) this.load();
  }
  dispose() {
    this.manager?.dispose();
  }

  private load() {
    if (this.loading) return;
    this.loading = true;
    import('./cameraManager').then(
      (module) => {
        const manager = new module.CameraManager();
        manager.setErrorSink(this.report);
        manager.subscribe(() => this.listeners.forEach((listener) => listener()));
        this.manager = manager;
        manager.setStreams(this.streams);
        this.listeners.forEach((listener) => listener());
      },
      () => {
        this.loading = false; // The next live poll tries again; camera widgets show their fallback meanwhile.
      },
    );
  }
}
