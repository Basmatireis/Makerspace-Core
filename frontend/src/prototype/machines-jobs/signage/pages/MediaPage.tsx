import { useState } from 'react';
import { Button, ClickableTile, ProgressBar, Search, Select, SelectItem, Tag } from '@carbon/react';
import { Upload } from '@carbon/icons-react';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { QueryBoundary } from '../../components/QueryBoundary';
import { RequirePermission } from '../../sales/components/RequirePermission';
import { useStore } from '../../store';
import { MediaDetailModal } from '../dialogs/MediaDetailModal';
import { UploadMediaModal } from '../dialogs/UploadMediaModal';
import { formatBytes, pluralize, scenesUsingMedia } from '../helpers';
import { GB_USED_BASE, STORAGE_LIMIT_BYTES } from '../mockData';
import { useSignage } from '../SignageContext';
import { useSignageQuery } from '../useSignageQuery';
import '../signage.scss';

export function MediaPage() {
  const store = useStore();
  const signage = useSignage();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');
  const [uploading, setUploading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const query = useSignageQuery(signage.media, []);
  const canUpload = store.can('signage.content.manage');
  const added = signage.media.filter((item) => !item.id.startsWith('media-')).reduce((sum, item) => sum + item.sizeBytes, 0);
  const used = GB_USED_BASE + added;
  const visible = query.data.filter((item) => (kind === 'all' || item.kind === kind) && item.name.toLowerCase().includes(search.trim().toLowerCase()));
  const open = signage.media.find((item) => item.id === openId) ?? null;
  const upload = canUpload ? <Button renderIcon={Upload} onClick={() => setUploading(true)}>Upload</Button> : undefined;

  return (
    <RequirePermission permission="signage.read" title="Media" crumbs={[{ label: 'Signage' }]}>
      <PageShell title="Media" description={`${formatBytes(used)} used`} width="wide" breadcrumbs={[{ label: 'Signage' }]} actions={upload}>
        <div className="mj-stack">
          <ProgressBar label="Storage" hideLabel helperText={`${formatBytes(used)} of ${formatBytes(STORAGE_LIMIT_BYTES)} used by signage media`} value={Math.round((used / STORAGE_LIMIT_BYTES) * 100)} max={100} size="small" />
          <div className="sg-toolbar">
            <Search id="media-search" labelText="Search media" placeholder="Search by name" size="lg" value={search} onChange={(event) => setSearch(event.target.value)} />
            <Select id="media-kind" labelText="Type" value={kind} onChange={(event) => setKind(event.target.value)}>
              <SelectItem value="all" text="All types" /><SelectItem value="image" text="Image" /><SelectItem value="video" text="Video" />
            </Select>
          </div>
          <QueryBoundary query={query} errorMessage="The media could not be loaded.">
            {visible.length === 0 ? (
              <EmptyState title={query.data.length === 0 ? 'No media yet' : 'No media found'} description={query.data.length === 0 ? 'Upload images and videos to use them in scenes.' : 'Try another search or type.'} action={query.data.length === 0 ? upload : undefined} />
            ) : (
              <div className="sg-tile-grid sg-tile-grid--media">
                {visible.map((item) => (
                  <ClickableTile key={item.id} className="sg-media-tile" onClick={() => setOpenId(item.id)} aria-label={`${item.name}, details`}>
                    <img className="sg-media-tile__image" src={item.src} alt="" />
                    <div className="sg-scene-tile__text">
                      <strong className="sg-media-tile__name">{item.name}</strong>
                      <span className="mj-secondary">{item.width} × {item.height} · {formatBytes(item.sizeBytes)}</span>
                      <div className="mj-inline">
                        <Tag size="sm" type="cool-gray">{item.kind === 'image' ? 'Image' : 'Video'}</Tag>
                        {item.status === 'converting' ? <Tag size="sm" type="blue">Converting for playback…</Tag> : item.kind === 'video' && <Tag size="sm" type="green">Ready</Tag>}
                      </div>
                      <span className="mj-secondary">Used in {pluralize(scenesUsingMedia(item, signage.scenes).length, 'scene')}</span>
                    </div>
                  </ClickableTile>
                ))}
              </div>
            )}
          </QueryBoundary>
        </div>
        {uploading && <UploadMediaModal onClose={() => setUploading(false)} />}
        {open && <MediaDetailModal media={open} onClose={() => setOpenId(null)} />}
      </PageShell>
    </RequirePermission>
  );
}
