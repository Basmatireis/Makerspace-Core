import { useMemo } from 'react';
import type { RenderedMessage, Scene, Sim } from '../types';
import { SceneRenderer, ScreenFrame } from './SceneRenderer';

const SIM: Sim = { h2d: 'idle', x1c: 'idle', coreReachable: true };

/** The rendered message in a landscape frame, drawn like a full-zone Announcement widget. */
export function AnnouncementPreview({ message }: { message: RenderedMessage }) {
  const scene = useMemo<Scene>(() => ({
    id: 'announcement-preview', name: 'Preview', orientation: 'landscape', templateId: 'full', background: '#161616', theme: 'dark',
    zones: { main: { type: 'announcement', templateIds: [], style: 'full', size: 'l', whenNone: 'empty', fallbackText: '', whenMany: 'newest', rotateSeconds: 10 } },
  }), []);
  const announcements = useMemo(() => [{ ...message, id: 'preview', templateId: '', startsAt: 0 }], [message]);
  return (
    <div className="sg-ann-preview">
      <ScreenFrame orientation="landscape"><SceneRenderer scene={scene} sim={SIM} now={0} media={[]} announcements={announcements} /></ScreenFrame>
    </div>
  );
}
