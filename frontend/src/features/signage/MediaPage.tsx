import './styles.scss';
import { useState } from 'react';
import { Button, ClickableTile, Search, Select, SelectItem, Tag } from '@carbon/react';
import { VideoFilled, Upload } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { QueryBoundary } from './components';
import { formatBytes, formatDuration, pluralize } from './helpers';
import { MediaDetailModal } from './MediaDetailModal';
import { assetContentUrl } from './preview';
import { assetsQuery, scenesQuery } from './queries';
import { UploadMediaModal } from './UploadMediaModal';
import { sceneAssetIds } from './widgets';

export function MediaPage() {
  const canEdit = hasPermission(useCurrentUser(), PermissionId.signagecontentmanage);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');
  const [uploading, setUploading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const assets = useQuery(assetsQuery());
  const scenes = useQuery(scenesQuery());
  const items = assets.data?.items ?? [];
  const used = items.reduce((sum, item) => sum + item.sizeBytes, 0);
  const visible = items.filter(
    (item) => (kind === 'all' || item.kind === kind) && item.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const open = items.find((item) => item.id === openId) ?? null;
  const scenesUsing = (assetId: string) =>
    (scenes.data?.items ?? []).filter((scene) => sceneAssetIds(scene).includes(assetId));
  const upload = canEdit ? (
    <Button renderIcon={Upload} onClick={() => setUploading(true)}>
      Upload
    </Button>
  ) : undefined;

  return (
    <PageShell
      title="Media"
      width="wide"
      breadcrumbs={[{ label: 'Signage' }]}
      actions={upload}
      description={assets.isSuccess ? `${pluralize(items.length, 'file')} · ${formatBytes(used)} used` : undefined}
    >
      <div className="sg-stack">
        <div className="sg-toolbar">
          <Search
            id="media-search"
            labelText="Search media"
            placeholder="Search by name"
            size="lg"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select id="media-kind" labelText="Type" value={kind} onChange={(event) => setKind(event.target.value)}>
            <SelectItem value="all" text="All types" />
            <SelectItem value="image" text="Image" />
            <SelectItem value="video" text="Video" />
          </Select>
        </div>
        <QueryBoundary query={assets} label="media">
          {visible.length === 0 ? (
            <EmptyState
              title={items.length === 0 ? 'No media yet' : 'No media found'}
              description={
                items.length === 0 ? 'Upload images and videos to use them in scenes.' : 'Try another search or type.'
              }
              action={items.length === 0 ? upload : undefined}
            />
          ) : (
            <div className="sg-tile-grid sg-tile-grid--media">
              {visible.map((item) => (
                <ClickableTile
                  key={item.id}
                  role="button"
                  className="sg-media-tile"
                  onClick={() => setOpenId(item.id)}
                  aria-label={`${item.name}, details`}
                >
                  {item.kind === 'image' ? (
                    <img
                      className="sg-media-tile__image"
                      src={assetContentUrl(item.id, item.sha256)}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <div className="sg-media-tile__image sg-media-tile__image--video">
                      <VideoFilled size={32} aria-hidden="true" />
                    </div>
                  )}
                  <div className="sg-scene-tile__text">
                    <strong className="sg-media-tile__name">{item.name}</strong>
                    <span className="sg-secondary">
                      {item.width && item.height ? `${item.width} × ${item.height} · ` : ''}
                      {formatBytes(item.sizeBytes)}
                      {item.durationMs ? ` · ${formatDuration(item.durationMs)}` : ''}
                    </span>
                    <div className="sg-inline">
                      <Tag size="sm" type="cool-gray">
                        {item.kind === 'image' ? 'Image' : 'Video'}
                      </Tag>
                    </div>
                    {scenes.isSuccess && (
                      <span className="sg-secondary">Used in {pluralize(scenesUsing(item.id).length, 'scene')}</span>
                    )}
                  </div>
                </ClickableTile>
              ))}
            </div>
          )}
        </QueryBoundary>
      </div>
      {uploading && <UploadMediaModal onClose={() => setUploading(false)} />}
      {open && (
        <MediaDetailModal
          key={open.id}
          asset={open}
          usedIn={scenesUsing(open.id)}
          canEdit={canEdit}
          onClose={() => setOpenId(null)}
        />
      )}
    </PageShell>
  );
}
