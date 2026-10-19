import { useState } from 'react';
import { Button, ClickableTile, Link as CarbonLink, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { Link, useNavigate } from 'react-router-dom';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { QueryBoundary } from '../../components/QueryBoundary';
import { SectionSwitcher } from '../../components/SectionSwitcher';
import { RequirePermission } from '../../sales/components/RequirePermission';
import { useUrlParams } from '../../sales/useUrlParams';
import { useStore } from '../../store';
import { SceneThumbnail } from '../components/SceneRenderer';
import { NewPlaylistModal, NewSceneModal } from '../dialogs/NewContentModals';
import { displayUsesPlaylist, formatLoop, loopSeconds, pluralize, sceneUsage } from '../helpers';
import { useSignage } from '../SignageContext';
import { useSignageQuery } from '../useSignageQuery';
import '../signage.scss';

const SECTIONS = [{ id: 'scenes', label: 'Scenes' }, { id: 'playlists', label: 'Playlists' }];

export function ContentPage() {
  const store = useStore();
  const signage = useSignage();
  const navigate = useNavigate();
  const { params, update } = useUrlParams();
  const section = params.get('section') === 'playlists' ? 'playlists' : 'scenes';
  const [creating, setCreating] = useState<'scene' | 'playlist' | null>(null);
  const query = useSignageQuery({ scenes: signage.scenes, playlists: signage.playlists }, { scenes: [], playlists: [] });
  const canEdit = store.can('signage.content.manage');
  const { scenes, playlists } = query.data;

  const create = canEdit ? (
    <Button renderIcon={Add} onClick={() => setCreating(section === 'scenes' ? 'scene' : 'playlist')}>{section === 'scenes' ? 'New scene' : 'New playlist'}</Button>
  ) : undefined;

  return (
    <RequirePermission permission="signage.read" title="Content" crumbs={[{ label: 'Signage' }]}>
      <PageShell title="Content" description="Scenes are single screens built from a layout; playlists play scenes in a loop. Edits are drafts until a display is published." width="wide" breadcrumbs={[{ label: 'Signage' }]} actions={create}>
        <div className="mj-stack">
          <SectionSwitcher label="Content type" sections={SECTIONS} selected={section} onChange={(id) => update({ section: id === 'scenes' ? null : id })} />
          <QueryBoundary query={query} errorMessage="The content could not be loaded.">
            {section === 'scenes' ? (
              scenes.length === 0 ? <EmptyState title="No scenes yet" description="A scene fills the screen with one layout and a widget per zone." action={create} /> : (
                <div className="sg-tile-grid">
                  {scenes.map((scene) => {
                    const usage = sceneUsage(scene.id, signage.playlists, signage.displays);
                    return (
                      <ClickableTile key={scene.id} className="sg-scene-tile" href={`#/signage/scenes/${scene.id}`} aria-label={`Scene ${scene.name}`}>
                        <div className={`sg-scene-tile__thumb sg-scene-tile__thumb--${scene.orientation}`}><SceneThumbnail scene={scene} media={signage.media} /></div>
                        <div className="sg-scene-tile__text">
                          <strong>{scene.name}</strong>
                          <div className="mj-inline"><Tag size="sm" type="cool-gray">{scene.orientation === 'portrait' ? 'Portrait' : 'Landscape'}</Tag>{scene.announcement && <Tag size="sm" type="warm-gray">Announcement</Tag>}</div>
                          <span className="mj-secondary">Used by {pluralize(usage.playlists, 'playlist')} · {pluralize(usage.rules, 'rule')}</span>
                        </div>
                      </ClickableTile>
                    );
                  })}
                </div>
              )
            ) : playlists.length === 0 ? <EmptyState title="No playlists yet" description="A playlist plays scenes one after another." action={create} /> : (
              <TableContainer className="mj-table-container">
                <Table aria-label="Playlists">
                  <TableHead><TableRow><TableHeader>Name</TableHeader><TableHeader>Scenes</TableHeader><TableHeader>Loop length</TableHeader><TableHeader>Used by displays</TableHeader></TableRow></TableHead>
                  <TableBody>
                    {playlists.map((playlist) => {
                      const users = signage.displays.filter((display) => displayUsesPlaylist(display, playlist.id));
                      return (
                        <TableRow key={playlist.id} className="mj-table-row" onClick={() => navigate(`/signage/playlists/${playlist.id}`)}>
                          <TableCell><CarbonLink as={Link} to={`/signage/playlists/${playlist.id}`} onClick={(event: React.MouseEvent) => event.stopPropagation()}>{playlist.name}</CarbonLink></TableCell>
                          <TableCell>{playlist.items.length}</TableCell>
                          <TableCell>{playlist.items.length === 0 ? '—' : formatLoop(loopSeconds(playlist))}</TableCell>
                          <TableCell>{users.length === 0 ? <span className="mj-secondary">Not used</span> : users.map((display) => display.name).join(', ')}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </QueryBoundary>
        </div>
        {creating === 'scene' && <NewSceneModal onClose={() => setCreating(null)} />}
        {creating === 'playlist' && <NewPlaylistModal onClose={() => setCreating(null)} />}
      </PageShell>
    </RequirePermission>
  );
}
