import { ComboBox, ContainedList, ContainedListItem, IconButton, NumberInput, Select, SelectItem, Tile } from '@carbon/react';
import { ArrowDown, ArrowUp, TrashCan } from '@carbon/icons-react';
import { useParams } from 'react-router-dom';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { QueryBoundary } from '../../components/QueryBoundary';
import { RequirePermission } from '../../sales/components/RequirePermission';
import { useNow, useStore } from '../../store';
import { SceneRenderer, SceneThumbnail, ScreenFrame } from '../components/SceneRenderer';
import { formatLoop, loopSeconds, uid } from '../helpers';
import { useSignage } from '../SignageContext';
import { useSignageQuery } from '../useSignageQuery';
import type { Playlist, Scene } from '../types';
import '../signage.scss';

export function PlaylistDetailPage() {
  const { playlistId = '' } = useParams();
  const signage = useSignage();
  const playlist = signage.playlists.find((item) => item.id === playlistId) ?? null;
  const query = useSignageQuery(playlist, null);
  const crumbs = [{ label: 'Signage' }, { label: 'Content', to: '/signage/content?section=playlists' }];
  return (
    <RequirePermission permission="signage.read" title="Playlist" crumbs={crumbs}>
      {query.status === 'success' && !playlist ? (
        <PageShell title="Playlist not found" breadcrumbs={crumbs} width="wide"><EmptyState title="This playlist does not exist" /></PageShell>
      ) : query.status !== 'success' || !query.data ? (
        <PageShell title="Playlist" breadcrumbs={crumbs} width="wide"><QueryBoundary query={query} errorMessage="The playlist could not be loaded."><EmptyState title="No data" /></QueryBoundary></PageShell>
      ) : <Detail playlistId={playlistId} crumbs={crumbs} />}
    </RequirePermission>
  );
}

/** Cycles through the playlist's items like a player would. */
function PlaylistPreview({ playlist, scenes }: { playlist: Playlist; scenes: Scene[] }) {
  const signage = useSignage();
  const now = useNow(1000);
  const items = playlist.items.filter((item) => scenes.some((scene) => scene.id === item.sceneId));
  const loop = loopSeconds({ ...playlist, items });
  if (items.length === 0 || loop === 0) return <p className="mj-secondary">Add a scene to see the preview.</p>;
  let position = (now / 1000) % loop;
  const current = items.find((item) => { if (position < item.seconds) return true; position -= item.seconds; return false; }) ?? items[0];
  const scene = scenes.find((item) => item.id === current.sceneId)!;
  return (
    <div className="mj-stack">
      <div className={`sg-detail__frame sg-detail__frame--${scene.orientation}`}>
        <ScreenFrame orientation={scene.orientation} width={scene.orientation === 'portrait' ? '12rem' : '100%'}>
          <div className={`sg-screen${current.transition === 'fade' ? ' sg-fade' : ''}`} key={current.id}><SceneRenderer scene={scene} sim={signage.sim} now={now} media={signage.media} /></div>
        </ScreenFrame>
      </div>
      <p className="mj-secondary">Now: {scene.name} · {Math.ceil(current.seconds - position)} s left</p>
    </div>
  );
}

function Detail({ playlistId, crumbs }: { playlistId: string; crumbs: { label: string; to?: string }[] }) {
  const store = useStore();
  const signage = useSignage();
  const playlist = signage.playlists.find((item) => item.id === playlistId)!;
  const canEdit = store.can('signage.content.manage');
  const items = playlist.items;
  const edit = (change: (list: Playlist['items']) => Playlist['items']) => signage.updatePlaylist(playlist.id, change);
  const move = (index: number, direction: -1 | 1) => edit((list) => { const next = [...list]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; return next; });

  return (
    <PageShell title={playlist.name} width="wide" breadcrumbs={crumbs} description={`Loop ${items.length === 0 ? '—' : formatLoop(loopSeconds(playlist))} · ${items.length} ${items.length === 1 ? 'scene' : 'scenes'}`}>
      <div className="sg-detail sg-detail--reverse">
        <div className="mj-stack">
          <ContainedList label="Scenes in this playlist" kind="on-page">
            {items.length === 0 && <ContainedListItem>No scenes yet</ContainedListItem>}
            {items.map((item, index) => {
              const scene = signage.scenes.find((entry) => entry.id === item.sceneId);
              return (
                <ContainedListItem key={item.id}>
                  <div className="sg-playlist-row">
                    <div className="sg-playlist-row__thumb">{scene && <SceneThumbnail scene={scene} media={signage.media} />}</div>
                    <strong className="sg-playlist-row__name">{scene?.name ?? 'Removed scene'}</strong>
                    {canEdit ? (
                      <>
                        <NumberInput id={`pli-seconds-${item.id}`} label="Seconds" size="sm" min={3} max={600} value={item.seconds} onChange={(_, { value }) => edit((list) => list.map((entry) => entry.id === item.id ? { ...entry, seconds: Math.max(3, Number(value) || 3) } : entry))} />
                        <Select id={`pli-transition-${item.id}`} labelText="Transition" size="sm" value={item.transition} onChange={(event) => edit((list) => list.map((entry) => entry.id === item.id ? { ...entry, transition: event.target.value as 'cut' | 'fade' } : entry))}>
                          <SelectItem value="cut" text="Cut" /><SelectItem value="fade" text="Fade" />
                        </Select>
                        <div className="sg-playlist-row__buttons">
                          <IconButton label="Move up" kind="ghost" size="sm" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp /></IconButton>
                          <IconButton label="Move down" kind="ghost" size="sm" disabled={index === items.length - 1} onClick={() => move(index, 1)}><ArrowDown /></IconButton>
                          <IconButton label="Remove from playlist" kind="ghost" size="sm" onClick={() => edit((list) => list.filter((entry) => entry.id !== item.id))}><TrashCan /></IconButton>
                        </div>
                      </>
                    ) : <span className="mj-secondary">{item.seconds} s · {item.transition === 'fade' ? 'Fade' : 'Cut'}</span>}
                  </div>
                </ContainedListItem>
              );
            })}
          </ContainedList>
          {canEdit && (
            <ComboBox<Scene> id="playlist-add-scene" titleText="Add scene" placeholder="Choose a scene" items={signage.scenes} itemToString={(item) => item?.name ?? ''} selectedItem={null}
              onChange={({ selectedItem }) => { if (selectedItem) edit((list) => [...list, { id: uid('pli'), sceneId: selectedItem.id, seconds: 20, transition: 'fade' }]); }} />
          )}
        </div>
        <Tile className="sg-detail__preview">
          <h2 className="mj-section-title">Preview</h2>
          <PlaylistPreview playlist={playlist} scenes={signage.scenes} />
        </Tile>
      </div>
    </PageShell>
  );
}
