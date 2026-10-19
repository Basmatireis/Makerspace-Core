import { Button, InlineNotification, Link as CarbonLink, Modal, StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper } from '@carbon/react';
import { Link } from 'react-router-dom';
import { useStore } from '../../store';
import { formatBytes, formatDateTime, publishedScenesUsingMedia, scenesUsingMedia } from '../helpers';
import { useSignage } from '../SignageContext';
import type { MediaItem } from '../types';

export function MediaDetailModal({ media, onClose }: { media: MediaItem; onClose: () => void }) {
  const signage = useSignage();
  const store = useStore();
  const usedIn = scenesUsingMedia(media, signage.scenes);
  const blocking = publishedScenesUsingMedia(media.id, signage.displays);
  const canDelete = store.can('signage.content.manage');
  const row = (label: string, value: React.ReactNode) => <StructuredListRow><StructuredListCell noWrap>{label}</StructuredListCell><StructuredListCell>{value}</StructuredListCell></StructuredListRow>;
  return (
    <Modal open size="md" passiveModal modalHeading={media.name} modalLabel={media.kind === 'image' ? 'Image' : 'Video'} onRequestClose={onClose}>
      <div className="sg-media-detail">
        <img className="sg-media-detail__image" src={media.src} alt="" />
        <StructuredListWrapper isCondensed aria-label="Media details">
          <StructuredListBody>
            {row('Dimensions', `${media.width} × ${media.height}`)}
            {row('Size', formatBytes(media.sizeBytes))}
            {row('Format', media.format)}
            {row('Checksum', <code>{media.checksum.slice(0, 20)}</code>)}
            {row('Uploaded', `${media.uploadedBy} · ${formatDateTime(media.uploadedAt)}`)}
            {row('Used in', usedIn.length === 0 ? 'No scene' : usedIn.map((scene, index) => <span key={scene.id}>{index > 0 && ', '}<CarbonLink as={Link} inline to={`/signage/scenes/${scene.id}`} onClick={onClose}>{scene.name}</CarbonLink></span>))}
          </StructuredListBody>
        </StructuredListWrapper>
        {canDelete && blocking.length > 0 && <InlineNotification kind="warning" lowContrast hideCloseButton title="Delete is blocked" subtitle={`Remove it from Scene ${blocking.map((scene) => scene.name).join(', ')} and publish first.`} />}
        {canDelete && blocking.length === 0 && (
          <div><Button kind="danger--tertiary" size="md" onClick={() => { signage.deleteMedia(media.id); store.notify({ kind: 'success', title: 'Media deleted', subtitle: media.name }); onClose(); }}>Delete media</Button></div>
        )}
      </div>
    </Modal>
  );
}
