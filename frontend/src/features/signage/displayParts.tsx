import { Tag } from '@carbon/react';
import type { SignageDisplay } from '../../api/generated/models';
import { SceneRenderer, ScreenFrame } from './render/SceneRenderer';
import { pluralize, relativeTime } from './helpers';
import type { PublishedView } from './publishedView';

export function StatusTag({ display, now }: { display: Pick<SignageDisplay, 'status' | 'lastHeartbeatAt'>; now: number }) {
  if (display.status === 'revoked') return <Tag type="gray" size="md">Revoked</Tag>;
  if (display.status === 'online') return <Tag type="green" size="md">Online</Tag>;
  return (
    <div className="sg-cell-stack">
      <Tag type="red" size="md">Offline</Tag>
      <span className="sg-secondary">{display.lastHeartbeatAt ? `last seen ${relativeTime(display.lastHeartbeatAt, now)}` : 'never seen'}</span>
    </div>
  );
}

export function PublicationTag({ display }: { display: Pick<SignageDisplay, 'publishedRevision' | 'pendingChanges'> }) {
  if (display.publishedRevision === null) return <Tag type="warm-gray" size="md">Not published</Tag>;
  if (display.pendingChanges.length === 0) return <Tag type="green" size="md">Up to date</Tag>;
  return <Tag type="warm-gray" size="md">{pluralize(display.pendingChanges.length, 'unpublished change')}</Tag>;
}

/** The scene on screen, in a frame of the display's aspect ratio. */
export function PublishedScreen({ view, orientation, resolution, width }: { view: PublishedView; orientation: SignageDisplay['orientation']; resolution?: SignageDisplay['resolution']; width?: string }) {
  return (
    <ScreenFrame orientation={orientation} resolution={resolution} width={width}>
      <div className={`sg-screen${view.transition === 'fade' ? ' sg-fade' : ''}`} key={view.itemKey}>
        <SceneRenderer scene={view.scene} data={view.data} screenOrientation={orientation} />
      </div>
    </ScreenFrame>
  );
}
