import { Component, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { SceneRenderer, ScreenFrame } from '../features/signage/render/SceneRenderer';
import type { PlayerApi } from './api';
import { runPairing, type PairingState } from './pairing';
import { PlayerRuntime } from './runtime';

const reloadPage = () => window.location.reload();

const TROUBLE_TEXT = { rate_limited: 'Too many requests, trying again shortly', offline: 'Cannot reach Makerspace Core, trying again', error: 'Something went wrong, trying again' } as const;

const clockText = (milliseconds: number) => {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function PairingScreen({ api, onPaired = reloadPage }: { api: Pick<PlayerApi, 'startPairing' | 'pollPairing'>; onPaired?: () => void }) {
  const [state, setState] = useState<PairingState>({ kind: 'starting' });
  const now = useNow(1000);
  useEffect(() => {
    const controller = new AbortController();
    void runPairing({ api, signal: controller.signal, onState: setState }).then((paired) => { if (paired) onPaired(); });
    return () => controller.abort();
  }, [api, onPaired]);

  const code = state.kind === 'waiting' ? state.code : null;
  const trouble = state.kind === 'waiting' || state.kind === 'claimed' ? state.trouble : state.kind === 'retrying' ? state.reason : undefined;
  return (
    <main className="pl-pairing">
      <h1 className="pl-pairing__title">This display is not paired</h1>
      {code && (
        <>
          <p className="pl-pairing__code" aria-label={`Pairing code ${code.split('').join(' ')}`}>{code}</p>
          <p className="pl-pairing__hint">Enter this code in Makerspace Core under Signage, Displays, Pair display.</p>
          <p className="pl-pairing__small">The code expires in {clockText(state.kind === 'waiting' ? state.expiresAt - now : 0)}. A new one appears automatically.</p>
        </>
      )}
      {state.kind === 'starting' && <p className="pl-pairing__hint">Requesting a pairing code</p>}
      {state.kind === 'claimed' && <p className="pl-pairing__hint">Pairing was started in Makerspace Core. Finishing set-up</p>}
      {state.kind === 'denied' && <p className="pl-pairing__hint pl-pairing__hint--error" role="alert">This network may not pair displays. Connect the display to the makerspace network.</p>}
      {state.kind === 'retrying' && <p className="pl-pairing__hint">Requesting a pairing code</p>}
      {trouble && <p className="pl-pairing__small pl-pairing__small--error" role="status">{TROUBLE_TEXT[trouble]}</p>}
    </main>
  );
}

export function PlayingScreen({ api, onRevoked }: { api: PlayerApi; onRevoked: () => void }) {
  const [runtime] = useState(() => new PlayerRuntime({ api }));
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  useEffect(() => { runtime.start(); return () => runtime.stop(); }, [runtime]);
  useEffect(() => { if (snapshot.status === 'revoked') onRevoked(); }, [snapshot.status, onRevoked]);

  const { view, display } = snapshot;
  return (
    <div className="pl-stage">
      {view && display ? (
        <ScreenFrame orientation={display.orientation} resolution={display.resolution} width={`min(100vw, calc(100vh * ${display.resolution.width / display.resolution.height}))`}>
          <div key={view.sceneKey} className={`pl-layer${view.transition === 'fade' ? ' sg-fade' : ''}`}>
            <SceneRenderer scene={view.scene} data={view.data} screenOrientation={display.orientation} />
          </div>
        </ScreenFrame>
      ) : (
        <p className="pl-message" role="status">
          {snapshot.status === 'unpublished' ? 'Waiting for content. Publish this display in Makerspace Core.' : !snapshot.online ? 'Connecting to Makerspace Core' : ''}
        </p>
      )}
      {!snapshot.online && view && <span className="pl-offline" role="status" aria-label="Offline, showing the last known content" />}
    </div>
  );
}

/** Unpaired displays show the pairing screen; a revoked credential brings the display back to it. */
export function PlayerApp({ api, onPaired }: { api: PlayerApi; onPaired?: () => void }) {
  const [mode, setMode] = useState<'play' | 'pair'>('play');
  return mode === 'pair' ? <PairingScreen api={api} onPaired={onPaired} /> : <PlayingScreen api={api} onRevoked={() => setMode('pair')} />;
}

/** A crash must not leave a dead screen on the wall: show a notice and reload after a while. */
export class FatalBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  private timer: ReturnType<typeof setTimeout> | undefined;
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.timer = setTimeout(reloadPage, 15_000); }
  componentWillUnmount() { clearTimeout(this.timer); }
  render() {
    return this.state.failed ? <main className="pl-pairing"><h1 className="pl-pairing__title">Display error</h1><p className="pl-pairing__hint">Restarting in a few seconds.</p></main> : this.props.children;
  }
}
