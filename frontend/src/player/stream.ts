// Browser side of the camera relay (docs/signage.md): Core relays go2rtc's MSE websocket protocol. The player opens a
// same-origin websocket to the path from the live data, sends the playable codecs, receives the mime type as a text
// frame and fragmented MP4 as binary frames. The session cookie or device token authorizes the upgrade, so no URL carries
// a secret. Errors carry fixed texts, never URLs.

export type StreamOffer = { path: string };

export type StreamErrorCode = 'forbidden' | 'gone' | 'closed' | 'unsupported' | 'aborted';

/** Websocket close codes Core uses towards viewers (docs/signage.md). */
export const CLOSE_FORBIDDEN = 4403;
export const CLOSE_GONE = 4404;

export class StreamError extends Error {
  constructor(
    readonly code: StreamErrorCode,
    message: string,
    readonly closeCode?: number,
  ) {
    super(message);
  }

  /** The viewer may not watch this camera (any more), or the camera is gone: retrying cannot help until the next live poll. */
  get final() {
    return this.code === 'forbidden' || this.code === 'gone';
  }
}

/** Shows a connection's picture in a video element; returns the function that detaches it. */
export type Feed = { attach(video: HTMLVideoElement): () => void };

export type Connection = {
  feed: Feed;
  /** Resolves when an established connection ends by itself. */
  closed: Promise<StreamError>;
  close(): void;
};

/** Browser APIs, replaceable in tests. */
export type StreamEnv = {
  WebSocket?: typeof WebSocket;
  MediaSource?: typeof MediaSource;
  location?: Pick<Location, 'protocol' | 'host'>;
};

const VIDEO_CODECS = ['avc1.640029', 'avc1.64002A', 'avc1.640033', 'hvc1.1.6.L153.B0', 'hev1.1.6.L153.B0'];
/** Fragments kept for the first video element while it is being mounted, and queued per element. */
const BACKLOG = 30;
/** Playback further than this behind the newest buffered data jumps forward to the live edge. */
export const LIVE_LAG_S = 3;
/** Distance from the end of the buffer after a jump. */
export const LIVE_MARGIN_S = 0.5;
/** Played data older than this is removed from the buffer. */
export const KEEP_PLAYED_S = 5;

/** The websocket URL for a stream path from the live data: same origin, so cookies and the CSP `connect-src 'self'` apply. */
export function streamSocketUrl(path: string, location: Pick<Location, 'protocol' | 'host'> = globalThis.location) {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`;
}

/** Maps a close code to the error that tells the manager whether retrying makes sense. */
export function closeError(code: number | undefined): StreamError {
  if (code === CLOSE_FORBIDDEN) return new StreamError('forbidden', 'the camera is not allowed here', code);
  if (code === CLOSE_GONE) return new StreamError('gone', 'the camera is gone', code);
  return new StreamError('closed', 'MSE connection closed', code);
}

type BufferedVideo = Pick<HTMLVideoElement, 'buffered' | 'currentTime'>;
type Trimmable = Pick<SourceBuffer, 'updating' | 'remove'>;

/** Keeps playback at the live edge (jumps forward when it lags) and drops what was played a while ago. */
export function tidyBuffer(video: BufferedVideo, buffer: Trimmable) {
  if (buffer.updating || video.buffered.length === 0) return;
  const start = video.buffered.start(0);
  const end = video.buffered.end(video.buffered.length - 1);
  if (end - video.currentTime > LIVE_LAG_S) video.currentTime = end - LIVE_MARGIN_S;
  const keepFrom = video.currentTime - KEEP_PLAYED_S;
  if (keepFrom - start > KEEP_PLAYED_S) {
    try {
      buffer.remove(start, keepFrom);
    } catch {
      /* retried after the next append */
    }
  }
}

/** One MediaSource per video element: appends queued fragments, trims what was played and stays near the live edge. */
function createSink(video: HTMLVideoElement, MS: typeof MediaSource, mime: string) {
  const source = new MS();
  const url = URL.createObjectURL(source);
  const queue: ArrayBuffer[] = [];
  let buffer: SourceBuffer | null = null;
  let dead = false;
  const pump = () => {
    if (dead || !buffer || buffer.updating || queue.length === 0) return;
    try {
      buffer.appendBuffer(queue.shift()!);
    } catch {
      queue.length = 0;
    }
  };
  source.addEventListener(
    'sourceopen',
    () => {
      if (dead) return;
      try {
        buffer = source.addSourceBuffer(mime);
      } catch {
        return;
      }
      buffer.mode = 'segments';
      buffer.addEventListener('updateend', () => {
        if (buffer) tidyBuffer(video, buffer);
        pump();
      });
      pump();
    },
    { once: true },
  );
  video.src = url;
  return {
    push(data: ArrayBuffer) {
      if (queue.length >= BACKLOG) queue.shift();
      queue.push(data);
      pump();
    },
    dispose() {
      dead = true;
      try {
        if (source.readyState === 'open') source.endOfStream();
      } catch {
        /* already closed */
      }
      URL.revokeObjectURL(url);
      if (video.src === url) video.removeAttribute('src');
    },
  };
}

/** Opens the MSE websocket; resolves with the connection once the initialisation segment has arrived. */
export function connectStream(offer: StreamOffer, env: StreamEnv, signal: AbortSignal): Promise<Connection> {
  const MS = env.MediaSource ?? globalThis.MediaSource;
  const Socket = env.WebSocket ?? globalThis.WebSocket;
  if (!MS || !Socket) return Promise.reject(new StreamError('unsupported', 'MSE is not available'));
  const codecs = VIDEO_CODECS.filter((codec) => MS.isTypeSupported(`video/mp4; codecs="${codec}"`));
  if (codecs.length === 0) return Promise.reject(new StreamError('unsupported', 'no playable video codec'));
  if (signal.aborted) return Promise.reject(new StreamError('aborted', 'aborted'));
  const socket = new Socket(streamSocketUrl(offer.path, env.location));
  socket.binaryType = 'arraybuffer';
  return new Promise<Connection>((resolve, reject) => {
    let mime = '';
    let init: ArrayBuffer | null = null;
    let backlog: ArrayBuffer[] = [];
    let ended!: (error: StreamError) => void;
    const closed = new Promise<StreamError>((done) => {
      ended = done;
    });
    const sinks = new Set<ReturnType<typeof createSink>>();
    const close = () => {
      socket.onclose = null;
      socket.close();
      sinks.forEach((sink) => sink.dispose());
      sinks.clear();
    };
    const lost = (error: StreamError) => {
      reject(error);
      ended(error);
      close();
    };
    const connection: Connection = {
      closed,
      close,
      feed: {
        attach(video) {
          const sink = createSink(video, MS, mime);
          if (init) sink.push(init);
          backlog.forEach((chunk) => sink.push(chunk));
          backlog = [];
          sinks.add(sink);
          void Promise.resolve(video.play?.()).catch(() => undefined);
          return () => {
            sinks.delete(sink);
            sink.dispose();
          };
        },
      },
    };
    signal.addEventListener(
      'abort',
      () => {
        reject(new StreamError('aborted', 'aborted'));
        close();
      },
      { once: true },
    );
    socket.onopen = () => socket.send(JSON.stringify({ type: 'mse', value: codecs.join(',') }));
    // A failed connection fires `error` and then `close`; the close event carries the code.
    socket.onclose = (event: Partial<CloseEvent> | undefined) => lost(closeError(event?.code));
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data) as { type?: string; value?: unknown };
          if (message.type === 'mse' && typeof message.value === 'string') mime = message.value;
        } catch {
          /* not for us */
        }
        return;
      }
      if (!mime) return;
      const chunk = event.data as ArrayBuffer;
      if (!init) {
        init = chunk;
        resolve(connection);
        return;
      }
      if (sinks.size > 0) sinks.forEach((sink) => sink.push(chunk));
      else backlog = [...backlog, chunk].slice(-BACKLOG);
    };
  });
}
