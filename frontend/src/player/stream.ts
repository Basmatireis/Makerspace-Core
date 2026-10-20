// Browser side of the streaming gateway's protocol (docs/streaming-gateway.md): go2rtc's WebRTC signalling (POST the SDP
// offer, receive the SDP answer) and its MSE websocket (send the playable codecs, receive fragmented MP4). The ticket
// travels as the `ticket` query parameter because a websocket cannot carry headers. Errors carry fixed texts, never URLs.

export type StreamOffer = { webrtcUrl: string; mseUrl: string; ticket: string };

export type StreamErrorCode = 'rejected' | 'http' | 'closed' | 'timeout' | 'unsupported' | 'aborted';

export class StreamError extends Error {
  constructor(readonly code: StreamErrorCode, message: string) { super(message); }
}

/** Shows a connection's picture in a video element; returns the function that detaches it. */
export type Feed = { attach(video: HTMLVideoElement): () => void };

export type Connection = {
  transport: 'webrtc' | 'mse';
  feed: Feed;
  /** Resolves when an established connection ends by itself. */
  closed: Promise<StreamError>;
  close(): void;
};

/** Browser APIs, replaceable in tests. */
export type StreamEnv = {
  RTCPeerConnection?: typeof RTCPeerConnection;
  WebSocket?: typeof WebSocket;
  MediaSource?: typeof MediaSource;
  fetch?: typeof fetch;
};

export const WEBRTC_BUDGET_MS = 4_000;
const GATHER_MS = 1_500;
const DISCONNECT_GRACE_MS = 5_000;
const VIDEO_CODECS = ['avc1.640029', 'avc1.64002A', 'avc1.640033', 'hvc1.1.6.L153.B0', 'hev1.1.6.L153.B0'];
/** Fragments kept for the first video element while it is being mounted, and queued per element. */
const BACKLOG = 30;

const withTicket = (url: string, ticket: string) => {
  const target = new URL(url, globalThis.location?.href);
  target.searchParams.set('ticket', ticket);
  return target.toString();
};

function iceGathered(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const done = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    // go2rtc has no trickle for this endpoint: whatever was gathered by the deadline goes into the offer.
    const timer = setTimeout(done, GATHER_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

async function connectWebRtc(offer: StreamOffer, env: StreamEnv, signal: AbortSignal): Promise<Connection> {
  const Peer = env.RTCPeerConnection ?? globalThis.RTCPeerConnection;
  if (!Peer) throw new StreamError('unsupported', 'WebRTC is not available');
  const pc = new Peer({ iceServers: [] }); // the gateway is on the LAN: no STUN
  let ended!: (error: StreamError) => void;
  const closed = new Promise<StreamError>((resolve) => { ended = resolve; });
  let stopFailing: () => void = () => undefined;
  const close = () => { stopFailing(); pc.close(); };
  try {
    const up = new Promise<MediaStream>((resolve, reject) => {
      let stream: MediaStream | null = null;
      let connected = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fail = (error: StreamError) => { reject(error); ended(error); };
      const ready = () => { if (stream && connected) resolve(stream); };
      stopFailing = () => clearTimeout(timer);
      signal.addEventListener('abort', () => reject(new StreamError('aborted', 'aborted')), { once: true });
      pc.ontrack = (event) => { stream = event.streams[0] ?? new MediaStream([event.track]); ready(); };
      pc.onconnectionstatechange = () => {
        clearTimeout(timer);
        if (pc.connectionState === 'connected') { connected = true; ready(); }
        else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') fail(new StreamError('closed', 'WebRTC connection lost'));
        else if (pc.connectionState === 'disconnected') timer = setTimeout(() => fail(new StreamError('closed', 'WebRTC connection lost')), DISCONNECT_GRACE_MS);
      };
    });
    up.catch(() => undefined);
    pc.addTransceiver('video', { direction: 'recvonly' });
    await pc.setLocalDescription(await pc.createOffer());
    await iceGathered(pc);
    if (signal.aborted) throw new StreamError('aborted', 'aborted');
    const response = await (env.fetch ?? fetch)(withTicket(offer.webrtcUrl, offer.ticket), { method: 'POST', body: pc.localDescription?.sdp ?? '', signal, credentials: 'omit' });
    if (response.status === 401 || response.status === 403) throw new StreamError('rejected', 'the gateway rejected the stream ticket');
    if (!response.ok) throw new StreamError('http', `WebRTC signalling failed (HTTP ${response.status})`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    const stream = await up;
    const feed: Feed = {
      attach(video) {
        video.srcObject = stream;
        void Promise.resolve(video.play?.()).catch(() => undefined);
        return () => { if (video.srcObject === stream) video.srcObject = null; };
      },
    };
    return { transport: 'webrtc', feed, closed, close };
  } catch (error) {
    close();
    throw error instanceof StreamError ? error : new StreamError(signal.aborted ? 'aborted' : 'closed', signal.aborted ? 'aborted' : 'WebRTC signalling failed');
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
    try { buffer.appendBuffer(queue.shift()!); } catch { queue.length = 0; }
  };
  const tidy = () => {
    if (!buffer || buffer.updating || video.buffered.length === 0) return;
    const start = video.buffered.start(0);
    const end = video.buffered.end(video.buffered.length - 1);
    if (end - video.currentTime > 4) video.currentTime = end - 0.5;
    if (end - start > 20) { try { buffer.remove(start, end - 10); } catch { /* retried after the next append */ } }
  };
  source.addEventListener('sourceopen', () => {
    if (dead) return;
    try { buffer = source.addSourceBuffer(mime); } catch { return; }
    buffer.mode = 'segments';
    buffer.addEventListener('updateend', () => { tidy(); pump(); });
    pump();
  }, { once: true });
  video.src = url;
  return {
    push(data: ArrayBuffer) { if (queue.length >= BACKLOG) queue.shift(); queue.push(data); pump(); },
    dispose() {
      dead = true;
      try { if (source.readyState === 'open') source.endOfStream(); } catch { /* already closed */ }
      URL.revokeObjectURL(url);
      if (video.src === url) video.removeAttribute('src');
    },
  };
}

async function connectMse(offer: StreamOffer, env: StreamEnv, signal: AbortSignal): Promise<Connection> {
  const MS = env.MediaSource ?? globalThis.MediaSource;
  const Socket = env.WebSocket ?? globalThis.WebSocket;
  if (!MS || !Socket) throw new StreamError('unsupported', 'MSE is not available');
  const codecs = VIDEO_CODECS.filter((codec) => MS.isTypeSupported(`video/mp4; codecs="${codec}"`));
  if (codecs.length === 0) throw new StreamError('unsupported', 'no playable video codec');
  const socket = new Socket(withTicket(offer.mseUrl, offer.ticket));
  socket.binaryType = 'arraybuffer';
  return new Promise<Connection>((resolve, reject) => {
    let mime = '';
    let init: ArrayBuffer | null = null;
    let backlog: ArrayBuffer[] = [];
    let ended!: (error: StreamError) => void;
    const closed = new Promise<StreamError>((done) => { ended = done; });
    const sinks = new Set<ReturnType<typeof createSink>>();
    const close = () => { socket.onclose = null; socket.onerror = null; socket.close(); sinks.forEach((sink) => sink.dispose()); sinks.clear(); };
    const lost = (error: StreamError) => { reject(error); ended(error); close(); };
    const connection: Connection = {
      transport: 'mse', closed, close,
      feed: {
        attach(video) {
          const sink = createSink(video, MS, mime);
          if (init) sink.push(init);
          backlog.forEach((chunk) => sink.push(chunk));
          backlog = [];
          sinks.add(sink);
          void Promise.resolve(video.play?.()).catch(() => undefined);
          return () => { sinks.delete(sink); sink.dispose(); };
        },
      },
    };
    signal.addEventListener('abort', () => { reject(new StreamError('aborted', 'aborted')); close(); }, { once: true });
    socket.onopen = () => socket.send(JSON.stringify({ type: 'mse', value: codecs.join(',') }));
    socket.onerror = () => lost(new StreamError('closed', 'MSE connection failed'));
    socket.onclose = () => lost(new StreamError('closed', 'MSE connection closed'));
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        try { const message = JSON.parse(event.data) as { type?: string; value?: unknown }; if (message.type === 'mse' && typeof message.value === 'string') mime = message.value; } catch { /* not for us */ }
        return;
      }
      if (!mime) return;
      const chunk = event.data as ArrayBuffer;
      if (!init) { init = chunk; resolve(connection); return; }
      if (sinks.size > 0) sinks.forEach((sink) => sink.push(chunk));
      else backlog = [...backlog, chunk].slice(-BACKLOG);
    };
  });
}

/** WebRTC first; MSE when WebRTC does not come up in time or fails (unless the ticket itself was refused). */
export async function connectStream(offer: StreamOffer, env: StreamEnv, signal: AbortSignal, webrtcMs = WEBRTC_BUDGET_MS): Promise<Connection> {
  const attempt = new AbortController();
  const abort = () => attempt.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, webrtcMs);
  try {
    return await connectWebRtc(offer, env, attempt.signal);
  } catch (error) {
    if (signal.aborted || (error instanceof StreamError && error.code === 'rejected')) throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
  return connectMse(offer, env, signal);
}
