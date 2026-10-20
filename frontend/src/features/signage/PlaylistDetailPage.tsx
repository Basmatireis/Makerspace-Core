import './styles.scss';
import { useState } from 'react';
import {
  Button,
  ComboBox,
  ContainedList,
  ContainedListItem,
  IconButton,
  InlineNotification,
  NumberInput,
  Select,
  SelectItem,
  TextInput,
  Tile,
} from '@carbon/react';
import { ArrowDown, ArrowUp, Save, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { SignagePlaylist, SignageScene, SignageTransition } from '../../api/generated/models';
import { deleteSignagePlaylist, updateSignagePlaylist } from '../../api/generated/signage/signage';
import { ApiError } from '../../api/http-client';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, FullPageLoading } from '../../app/PageState';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { DeleteDialog, SceneThumbnail } from './components';
import { loopSeconds, playlistPosition } from './engine/playback';
import { errorMessage, formatLoop, isStaleWrite, pluralize } from './helpers';
import { signagePaths } from './paths';
import { useNow, usePreviewData } from './preview';
import { playlistQuery, scenesQuery, signageKeys } from './queries';
import { SceneRenderer, ScreenFrame } from './render/SceneRenderer';

type Row = { key: number; sceneId: string; seconds: number; transition: SignageTransition };
type Draft = { name: string; rows: Row[] };
let nextKey = 0;
const toDraft = (playlist: SignagePlaylist): Draft => ({
  name: playlist.name,
  rows: playlist.items.map((item) => ({ ...item, key: (nextKey += 1) })),
});
const sameAsSaved = (draft: Draft, playlist: SignagePlaylist) =>
  draft.name === playlist.name &&
  draft.rows.length === playlist.items.length &&
  draft.rows.every(
    (row, index) =>
      row.sceneId === playlist.items[index].sceneId &&
      row.seconds === playlist.items[index].seconds &&
      row.transition === playlist.items[index].transition,
  );

export function PlaylistDetailPage() {
  const { playlistId = '' } = useParams();
  const query = useQuery(playlistQuery(playlistId));
  const crumbs = [{ label: 'Signage' }, { label: 'Content', to: signagePaths.content('playlists') }];
  if (query.isPending)
    return (
      <PageShell title="Playlist" width="wide" breadcrumbs={crumbs}>
        <FullPageLoading label="Loading playlist" />
      </PageShell>
    );
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <PageShell title={missing ? 'Playlist not found' : 'Playlist'} width="wide" breadcrumbs={crumbs}>
        {missing ? (
          <EmptyState title="This playlist does not exist" description="It may have been deleted." />
        ) : (
          <ErrorState
            message={errorMessage(query.error, 'The playlist could not be loaded.')}
            onRetry={() => void query.refetch()}
          />
        )}
      </PageShell>
    );
  }
  return <Detail key={query.data.id} playlist={query.data} crumbs={crumbs} />;
}

/** Cycles through the playlist's items like a player would. */
function PlaylistPreview({ rows, scenes }: { rows: Row[]; scenes: SignageScene[] }) {
  const now = useNow(1000);
  const data = usePreviewData('idle', { now });
  const items = rows.filter((row) => scenes.some((scene) => scene.id === row.sceneId));
  const current = playlistPosition(items, now / 1000);
  if (!current) return <p className="sg-secondary">Add a scene to see the preview.</p>;
  const scene = scenes.find((item) => item.id === current.item.sceneId)!;
  return (
    <div className="sg-stack">
      <div className={`sg-detail__frame sg-detail__frame--${scene.orientation}`}>
        <ScreenFrame orientation={scene.orientation} width={scene.orientation === 'portrait' ? '12rem' : '100%'}>
          <div
            className={`sg-screen${current.item.transition === 'fade' ? ' sg-fade' : ''}`}
            key={`${current.index}-${current.item.key}`}
          >
            <SceneRenderer scene={scene} data={data} />
          </div>
        </ScreenFrame>
      </div>
      <p className="sg-secondary">
        Now: {scene.name} · {current.secondsLeft} s left
      </p>
    </div>
  );
}

function Detail({ playlist, crumbs }: { playlist: SignagePlaylist; crumbs: { label: string; to?: string }[] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canEdit = hasPermission(useCurrentUser(), PermissionId.signagecontentmanage);
  const scenesResult = useQuery(scenesQuery());
  const scenes = scenesResult.data?.items ?? [];
  const [draft, setDraft] = useState<Draft>(() => toDraft(playlist));
  const [deleting, setDeleting] = useState(false);
  const [addKey, setAddKey] = useState(0);
  const [base, setBase] = useState(playlist);
  const dirty = canEdit && !sameAsSaved(draft, base);
  const invalid = draft.name.trim() === '' || draft.rows.some((row) => row.seconds < 3 || row.seconds > 3600);
  const unsavedChanges = useUnsavedChanges({ isDirty: dirty });

  const save = useMutation({
    mutationFn: () =>
      updateSignagePlaylist(playlist.id, {
        expectedVersion: base.version,
        name: draft.name.trim(),
        items: draft.rows.map(({ sceneId, seconds, transition }) => ({ sceneId, seconds, transition })),
      }),
    onSuccess: async (updated) => {
      setBase(updated);
      setDraft({ name: updated.name, rows: draft.rows });
      queryClient.setQueryData(signageKeys.playlist(playlist.id), updated);
      await queryClient.invalidateQueries({ queryKey: signageKeys.playlists() });
    },
  });
  const reload = async () => {
    const fresh = await queryClient.fetchQuery({ ...playlistQuery(playlist.id), staleTime: 0 });
    setBase(fresh);
    setDraft(toDraft(fresh));
    save.reset();
  };

  const edit = (change: (rows: Row[]) => Row[]) => setDraft((current) => ({ ...current, rows: change(current.rows) }));
  const patchRow = (key: number, patch: Partial<Row>) =>
    edit((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const move = (index: number, direction: -1 | 1) =>
    edit((rows) => {
      const next = [...rows];
      [next[index], next[index + direction]] = [next[index + direction], next[index]];
      return next;
    });
  const total = loopSeconds(draft.rows);

  return (
    <PageShell
      title={base.name}
      width="wide"
      breadcrumbs={crumbs}
      description={`Loop ${draft.rows.length === 0 ? '—' : formatLoop(total)} · ${pluralize(draft.rows.length, 'scene')}`}
      actions={
        canEdit ? (
          <>
            <Button kind="danger--tertiary" renderIcon={TrashCan} onClick={() => setDeleting(true)}>
              Delete playlist
            </Button>
            <Button renderIcon={Save} disabled={!dirty || invalid || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save playlist'}
            </Button>
          </>
        ) : undefined
      }
    >
      {save.isError && (
        <>
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title={isStaleWrite(save.error) ? 'This playlist was changed somewhere else' : 'Playlist not saved'}
            subtitle={
              isStaleWrite(save.error)
                ? 'Load the latest version to continue. Your edits here will be replaced.'
                : errorMessage(save.error)
            }
          />
          {isStaleWrite(save.error) && (
            <div className="sg-conflict-actions">
              <Button size="sm" kind="tertiary" onClick={() => void reload()}>
                Load latest
              </Button>
            </div>
          )}
        </>
      )}
      <div className="sg-detail sg-detail--reverse">
        <div className="sg-stack">
          {canEdit && (
            <TextInput
              id="playlist-settings-name"
              labelText="Name"
              maxLength={100}
              value={draft.name}
              invalid={draft.name.trim() === ''}
              invalidText="A playlist needs a name"
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
          )}
          <ContainedList label="Scenes in this playlist" kind="on-page">
            {draft.rows.length === 0 && <ContainedListItem>No scenes yet</ContainedListItem>}
            {draft.rows.map((row, index) => {
              const scene = scenes.find((entry) => entry.id === row.sceneId);
              return (
                <ContainedListItem key={row.key}>
                  <div className="sg-playlist-row">
                    <div className="sg-playlist-row__thumb">{scene && <SceneThumbnail scene={scene} />}</div>
                    <strong className="sg-playlist-row__name">
                      {scene?.name ?? (scenesResult.isSuccess ? 'Removed scene' : 'Scene')}
                    </strong>
                    {canEdit ? (
                      <>
                        <NumberInput
                          id={`pli-seconds-${row.key}`}
                          label="Seconds"
                          size="sm"
                          min={3}
                          max={3600}
                          value={row.seconds}
                          invalid={row.seconds < 3 || row.seconds > 3600}
                          invalidText="3 to 3600"
                          onChange={(_, { value }) => {
                            const seconds = Number(value);
                            if (value !== '' && Number.isFinite(seconds))
                              patchRow(row.key, { seconds: Math.round(seconds) });
                          }}
                        />
                        <Select
                          id={`pli-transition-${row.key}`}
                          labelText="Transition"
                          size="sm"
                          value={row.transition}
                          onChange={(event) =>
                            patchRow(row.key, { transition: event.target.value as SignageTransition })
                          }
                        >
                          <SelectItem value="cut" text="Cut" />
                          <SelectItem value="fade" text="Fade" />
                        </Select>
                        <div className="sg-playlist-row__buttons">
                          <IconButton
                            label="Move up"
                            kind="ghost"
                            size="sm"
                            disabled={index === 0}
                            onClick={() => move(index, -1)}
                          >
                            <ArrowUp />
                          </IconButton>
                          <IconButton
                            label="Move down"
                            kind="ghost"
                            size="sm"
                            disabled={index === draft.rows.length - 1}
                            onClick={() => move(index, 1)}
                          >
                            <ArrowDown />
                          </IconButton>
                          <IconButton
                            label="Remove from playlist"
                            kind="ghost"
                            size="sm"
                            onClick={() => edit((rows) => rows.filter((entry) => entry.key !== row.key))}
                          >
                            <TrashCan />
                          </IconButton>
                        </div>
                      </>
                    ) : (
                      <span className="sg-secondary">
                        {row.seconds} s · {row.transition === 'fade' ? 'Fade' : 'Cut'}
                      </span>
                    )}
                  </div>
                </ContainedListItem>
              );
            })}
          </ContainedList>
          {canEdit && draft.rows.length < 100 && (
            <ComboBox<SignageScene>
              key={addKey}
              id="playlist-add-scene"
              titleText="Add scene"
              placeholder="Choose a scene"
              items={scenes}
              itemToString={(item) => item?.name ?? ''}
              selectedItem={null}
              onChange={({ selectedItem }) => {
                if (selectedItem) {
                  edit((rows) => [
                    ...rows,
                    { key: (nextKey += 1), sceneId: selectedItem.id, seconds: 20, transition: 'fade' },
                  ]);
                  setAddKey((key) => key + 1);
                }
              }}
            />
          )}
        </div>
        <Tile className="sg-detail__preview">
          <h2 className="sg-section-title">Preview</h2>
          <PlaylistPreview rows={draft.rows} scenes={scenes} />
        </Tile>
      </div>
      {deleting && (
        <DeleteDialog
          title={`Delete “${base.name}”?`}
          noun="Playlist"
          confirmLabel="Delete playlist"
          remove={() => deleteSignagePlaylist(playlist.id, { expectedVersion: base.version })}
          onDeleted={() => unsavedChanges.bypassAfterSubmit(() => navigate(signagePaths.content('playlists')))}
          onClose={() => setDeleting(false)}
        >
          <p>
            The playlist is removed; its scenes stay. A playlist that a display uses as default or in a rule cannot be
            deleted.
          </p>
        </DeleteDialog>
      )}
      <UnsavedChangesDialog
        guard={unsavedChanges}
        title="Discard unsaved playlist changes?"
        message="Your changes to this playlist have not been saved."
      />
    </PageShell>
  );
}
