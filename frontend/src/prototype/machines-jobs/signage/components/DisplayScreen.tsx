import { useMemo } from 'react';
import { playbackOf } from '../helpers';
import type { Display, MediaItem, Scene, Sim } from '../types';
import { SceneRenderer, ScreenFrame } from './SceneRenderer';

/** What a paired player shows right now: the resolved rule's scene, or the playlist's current scene (fading between items). */
export function DisplayScreen({ display, sim, now, media, width }: { display: Display; sim: Sim; now: number; media: MediaItem[]; width?: string }) {
  const playback = useMemo(() => playbackOf(display, sim, now), [display, sim, now]);
  const { scenes, playlists } = display.published;

  let scene: Scene | null = null;
  let fade = false;
  let key = 'none';
  let note: string | null = null;
  if (playback.target.type === 'scene') {
    scene = scenes.find((item) => item.id === playback.target.id) ?? null;
    if (!scene && playback.announcement?.text) {
      scene = { id: 'announcement-text', name: 'Announcement', orientation: display.orientation, templateId: 'full', background: '#a2191f', theme: 'dark', zones: { main: { type: 'text', text: playback.announcement.text, size: 'xl', align: 'center' } } };
    }
    key = scene?.id ?? 'missing';
    if (!scene) note = 'This scene was removed.';
  } else {
    const playlist = playlists.find((item) => item.id === playback.target.id);
    const items = playlist?.items.filter((item) => scenes.some((entry) => entry.id === item.sceneId)) ?? [];
    const loop = items.reduce((sum, item) => sum + item.seconds, 0);
    if (items.length === 0 || loop === 0) {
      note = 'Nothing to show: the playlist is empty.';
    } else {
      let position = (now / 1000) % loop;
      const current = items.find((item) => { if (position < item.seconds) return true; position -= item.seconds; return false; }) ?? items[0];
      scene = scenes.find((item) => item.id === current.sceneId) ?? null;
      fade = current.transition === 'fade';
      key = current.id;
    }
  }

  return (
    <ScreenFrame orientation={display.orientation} resolution={display.resolution} width={width}>
      <div className={`sg-screen${fade ? ' sg-fade' : ''}`} key={key}>
        <SceneRenderer scene={scene} screenOrientation={display.orientation} sim={sim} now={now} media={media} playback={playback} />
      </div>
      {note && <div className="sg-note">{note}</div>}
      {!sim.coreReachable && <span className="sg-offline-dot" role="img" aria-label="Core unreachable" title="Core unreachable: showing cached content" />}
    </ScreenFrame>
  );
}
