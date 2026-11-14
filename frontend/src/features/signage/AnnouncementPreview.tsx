import type { SignageRichTextFormat, SignageTone } from '../../api/generated/models';
import type { AnnouncementLook } from './announcementLook';
import { SceneRenderer, ScreenFrame } from './render/SceneRenderer';
import { sceneGridSize } from './render/aspect';
import type { RenderData, RenderScene } from './render/types';
import { defaultBlockStyle } from './widgets';

const RATIO = { width: 16, height: 9 };
const GRID = sceneGridSize(RATIO);

const SCENE: RenderScene = {
  aspectRatio: RATIO,
  backgroundColor: '#161616',
  backgroundAssetId: null,
  backgroundFit: 'cover',
  backgroundDim: 0,
  theme: 'dark',
  blocks: [
    {
      id: 'main',
      name: 'Announcement',
      x: 0,
      y: 0,
      w: GRID.width,
      h: GRID.height,
      hidden: false,
      locked: false,
      widget: {
        type: 'announcement',
        templateIds: [],
        style: 'full',
        whenNone: 'empty',
        fallbackText: '',
        whenMany: 'newest',
        rotateSeconds: 10,
      },
      // Large text (the old size "l"), centred, like a full-screen announcement block.
      style: { ...defaultBlockStyle('announcement'), textSize: 76, align: 'center' },
    },
  ],
};

/** A rendered message in a landscape frame, drawn like a full-zone Announcement widget. */
export function AnnouncementPreview({
  message,
}: {
  message: {
    title: string;
    body: string;
    tone: SignageTone;
    bodyFormat?: SignageRichTextFormat;
    bodyCss?: string;
  } & Partial<AnnouncementLook>;
}) {
  const data: RenderData = {
    now: 0,
    liveAvailable: true,
    machines: [],
    announcements: [{ ...message, id: 'preview', templateId: '', startsAt: 0 }],
    openDays: [],
    events: [],
    assetUrl: () => null,
    still: true,
  };
  return (
    <div className="sg-ann-preview">
      <ScreenFrame aspectRatio={SCENE.aspectRatio}>
        <SceneRenderer scene={SCENE} data={data} />
      </ScreenFrame>
    </div>
  );
}
