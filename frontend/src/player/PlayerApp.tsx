import { Component, lazy, Suspense, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { RuleNotices } from '../features/signage/render/RuleNotices';
import { SceneRenderer, ScreenFrame } from '../features/signage/render/SceneRenderer';
import type { PlayerApi } from './api';
import { PlayerRuntime } from './runtime';

const reloadPage = () => window.location.reload();

// Only unpaired (or revoked) displays show the pairing screen; the player's initial JavaScript has a budget (its chunk is precached).
const PairingScreen = lazy(() => import('./PairingScreen').then((module) => ({ default: module.PairingScreen })));

export function PlayingScreen({ api, onRevoked }: { api: PlayerApi; onRevoked: () => void }) {
  const [runtime] = useState(() => new PlayerRuntime({ api }));
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  useEffect(() => {
    runtime.start();
    return () => runtime.stop();
  }, [runtime]);
  useEffect(() => {
    if (snapshot.status === 'revoked') onRevoked();
  }, [snapshot.status, onRevoked]);

  const { view, display } = snapshot;
  return (
    <div className="pl-stage">
      {view && display ? (
        <ScreenFrame
          aspectRatio={display.aspectRatio}
          width={`min(100vw, calc(100vh * ${display.aspectRatio.width / display.aspectRatio.height}))`}
        >
          <div key={view.sceneKey} className={`pl-layer${view.transition === 'fade' ? ' sg-fade' : ''}`}>
            <SceneRenderer scene={view.scene} data={view.data} />
          </div>
          <RuleNotices notices={view.ruleNotices} />
        </ScreenFrame>
      ) : (
        <p className="pl-message" role="status">
          {snapshot.status === 'unpublished'
            ? 'Waiting for content. Publish this display in Makerspace Core.'
            : !snapshot.online
              ? 'Connecting to Makerspace Core'
              : ''}
        </p>
      )}
      {!snapshot.online && view && (
        <span className="pl-offline" role="status" aria-label="Offline, showing the last known content" />
      )}
    </div>
  );
}

/** Unpaired displays show the pairing screen; a revoked credential brings the display back to it. */
export function PlayerApp({ api, onPaired }: { api: PlayerApi; onPaired?: () => void }) {
  const [mode, setMode] = useState<'play' | 'pair'>('play');
  return mode === 'pair' ? (
    <Suspense fallback={null}>
      <PairingScreen api={api} onPaired={onPaired} />
    </Suspense>
  ) : (
    <PlayingScreen api={api} onRevoked={() => setMode('pair')} />
  );
}

/** A crash must not leave a dead screen on the wall: show a notice and reload after a while. */
export class FatalBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  private timer: ReturnType<typeof setTimeout> | undefined;
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.timer = setTimeout(reloadPage, 15_000);
  }
  componentWillUnmount() {
    clearTimeout(this.timer);
  }
  render() {
    return this.state.failed ? (
      <main className="pl-pairing">
        <h1 className="pl-pairing__title">Display error</h1>
        <p className="pl-pairing__hint">Restarting in a few seconds.</p>
      </main>
    ) : (
      this.props.children
    );
  }
}
