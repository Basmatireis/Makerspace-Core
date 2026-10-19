import { useMemo } from 'react';
import type { SignageTone } from '../../api/generated/models';
import { SceneRenderer, ScreenFrame } from './render/SceneRenderer';
import type { RenderData, RenderScene } from './render/types';

const SCENE: RenderScene = {
  orientation: 'landscape', layoutId: 'full', backgroundColor: '#161616', backgroundAssetId: null, backgroundFit: 'cover', backgroundDim: 0, theme: 'dark',
  zones: { main: { type: 'announcement', templateIds: [], style: 'full', size: 'l', whenNone: 'empty', fallbackText: '', whenMany: 'newest', rotateSeconds: 10 } },
};

/** A rendered message in a landscape frame, drawn like a full-zone Announcement widget. */
export function AnnouncementPreview({ message }: { message: { title: string; body: string; tone: SignageTone } }) {
  const data = useMemo<RenderData>(() => ({
    now: 0, liveAvailable: true, machines: [], announcements: [{ ...message, id: 'preview', templateId: '', startsAt: 0 }], openDays: [], events: [], assetUrl: () => null, still: true,
  }), [message]);
  return (
    <div className="sg-ann-preview">
      <ScreenFrame orientation="landscape"><SceneRenderer scene={SCENE} data={data} /></ScreenFrame>
    </div>
  );
}
