import './styles.scss';
import { useState } from 'react';
import {
  Button,
  ClickableTile,
  Link as CarbonLink,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import { Add, Edit, TrashCan } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { SignageAnnouncementTemplate, SignageTone } from '../../api/generated/models';
import { deleteSignageAnnouncementTemplate } from '../../api/generated/signage/signage';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { RowActions } from '../../app/RowActions';
import { SectionSwitcher } from '../../app/SectionSwitcher';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { AnnouncementTemplateModal } from './AnnouncementTemplateModal';
import { DeleteDialog, QueryBoundary, SceneThumbnail } from './components';
import { formatLoop, orientationLabel, pluralize } from './helpers';
import { loopSeconds } from './engine/playback';
import { NewPlaylistModal, NewSceneModal } from './NewContentModals';
import { signagePaths } from './paths';
import { announcementsQuery, playlistsQuery, scenesQuery, templatesQuery } from './queries';

type Section = 'scenes' | 'playlists' | 'announcements';
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'scenes', label: 'Scenes' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'announcements', label: 'Announcements' },
];
const TONE_TAG: Record<SignageTone, 'blue' | 'warm-gray' | 'red' | 'gray'> = {
  info: 'blue',
  warning: 'warm-gray',
  critical: 'red',
  neutral: 'gray',
};
const TONE_LABEL: Record<SignageTone, string> = {
  info: 'Info',
  warning: 'Warning',
  critical: 'Critical',
  neutral: 'Neutral',
};

export function ContentPage() {
  const canEdit = hasPermission(useCurrentUser(), PermissionId.signagecontentmanage);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requested = params.get('section');
  const section: Section = requested === 'playlists' || requested === 'announcements' ? requested : 'scenes';
  const [creating, setCreating] = useState<'scene' | 'playlist' | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<SignageAnnouncementTemplate | 'new' | null>(null);
  const [deletingTemplate, setDeletingTemplate] = useState<SignageAnnouncementTemplate | null>(null);
  const scenes = useQuery(scenesQuery());
  const playlists = useQuery(playlistsQuery());
  const templates = useQuery(templatesQuery());
  const announcements = useQuery(announcementsQuery());
  const query = section === 'scenes' ? scenes : section === 'playlists' ? playlists : templates;

  const createLabel = section === 'scenes' ? 'New scene' : section === 'playlists' ? 'New playlist' : 'New template';
  const create = canEdit ? (
    <Button
      renderIcon={Add}
      onClick={() => {
        if (section === 'announcements') setEditingTemplate('new');
        else setCreating(section === 'scenes' ? 'scene' : 'playlist');
      }}
    >
      {createLabel}
    </Button>
  ) : undefined;
  const open = (event: { preventDefault: () => void }, to: string) => {
    event.preventDefault();
    navigate(to);
  };

  return (
    <PageShell
      title="Content"
      width="wide"
      breadcrumbs={[{ label: 'Signage' }]}
      actions={create}
      description="Scenes are single screens built from a layout; playlists play scenes in a loop; announcement templates define live messages. Scene and playlist edits are drafts until a display is published."
    >
      <div className="sg-stack">
        <SectionSwitcher
          label="Content type"
          sections={SECTIONS}
          selected={section}
          onChange={(id) => setParams(id === 'scenes' ? {} : { section: id }, { replace: true })}
        />
        <QueryBoundary
          query={query}
          label={section === 'scenes' ? 'scenes' : section === 'playlists' ? 'playlists' : 'announcement templates'}
        >
          {section === 'scenes' &&
            (scenes.data?.items.length === 0 ? (
              <EmptyState
                title="No scenes yet"
                description="A scene fills the screen with one layout and a widget per zone."
                action={create}
              />
            ) : (
              <div className="sg-tile-grid">
                {scenes.data?.items.map((scene) => {
                  const usedBy = (playlists.data?.items ?? []).filter((playlist) =>
                    playlist.items.some((item) => item.sceneId === scene.id),
                  ).length;
                  return (
                    <ClickableTile
                      key={scene.id}
                      className="sg-scene-tile"
                      href={signagePaths.scene(scene.id)}
                      aria-label={`Scene ${scene.name}`}
                      onClick={(event: { preventDefault: () => void }) => open(event, signagePaths.scene(scene.id))}
                    >
                      <div className={`sg-scene-tile__thumb sg-scene-tile__thumb--${scene.orientation}`}>
                        <SceneThumbnail scene={scene} />
                      </div>
                      <div className="sg-scene-tile__text">
                        <strong>{scene.name}</strong>
                        <div className="sg-inline">
                          <Tag size="sm" type="cool-gray">
                            {orientationLabel(scene.orientation)}
                          </Tag>
                        </div>
                        {playlists.isSuccess && (
                          <span className="sg-secondary">Used in {pluralize(usedBy, 'playlist')}</span>
                        )}
                      </div>
                    </ClickableTile>
                  );
                })}
              </div>
            ))}
          {section === 'playlists' &&
            (playlists.data?.items.length === 0 ? (
              <EmptyState
                title="No playlists yet"
                description="A playlist plays scenes one after another."
                action={create}
              />
            ) : (
              <TableContainer>
                <Table aria-label="Playlists">
                  <TableHead>
                    <TableRow>
                      <TableHeader>Name</TableHeader>
                      <TableHeader>Scenes</TableHeader>
                      <TableHeader>Loop length</TableHeader>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {playlists.data?.items.map((playlist) => (
                      <TableRow key={playlist.id}>
                        <TableCell>
                          <CarbonLink as={Link} to={signagePaths.playlist(playlist.id)}>
                            {playlist.name}
                          </CarbonLink>
                        </TableCell>
                        <TableCell>{playlist.items.length}</TableCell>
                        <TableCell>
                          {playlist.items.length === 0 ? '—' : formatLoop(loopSeconds(playlist.items))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            ))}
          {section === 'announcements' &&
            (templates.data?.items.length === 0 ? (
              <EmptyState
                title="No announcement templates yet"
                description="A template defines the fields and the message of a kind of announcement, such as “Closed”."
                action={create}
              />
            ) : (
              <TableContainer>
                <Table aria-label="Announcement templates">
                  <TableHead>
                    <TableRow>
                      <TableHeader>Name</TableHeader>
                      <TableHeader>Tone</TableHeader>
                      <TableHeader className="sg-hide-narrow">Message</TableHeader>
                      <TableHeader className="sg-hide-narrow">Fields</TableHeader>
                      <TableHeader>In use</TableHeader>
                      {canEdit && (
                        <TableHeader>
                          <span className="cds--visually-hidden">Actions</span>
                        </TableHeader>
                      )}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {templates.data?.items.map((template) => {
                      const inUse = (announcements.data?.items ?? []).filter(
                        (item) => item.templateId === template.id,
                      ).length;
                      return (
                        <TableRow key={template.id}>
                          <TableCell>
                            {canEdit ? (
                              <CarbonLink
                                href="#"
                                onClick={(event: { preventDefault: () => void }) => {
                                  event.preventDefault();
                                  setEditingTemplate(template);
                                }}
                              >
                                {template.name}
                              </CarbonLink>
                            ) : (
                              template.name
                            )}
                          </TableCell>
                          <TableCell>
                            <Tag size="sm" type={TONE_TAG[template.tone]}>
                              {TONE_LABEL[template.tone]}
                            </Tag>
                          </TableCell>
                          <TableCell className="sg-hide-narrow">{template.title}</TableCell>
                          <TableCell className="sg-hide-narrow">
                            {template.fields.length === 0
                              ? '—'
                              : template.fields.map((field) => field.label).join(', ')}
                          </TableCell>
                          <TableCell>
                            {!announcements.isSuccess ? (
                              '—'
                            ) : inUse === 0 ? (
                              <span className="sg-secondary">Not in use</span>
                            ) : (
                              pluralize(inUse, 'announcement')
                            )}
                          </TableCell>
                          {canEdit && (
                            <TableCell>
                              <RowActions label={`Actions for ${template.name}`}>
                                <Button
                                  kind="ghost"
                                  size="sm"
                                  renderIcon={Edit}
                                  onClick={() => setEditingTemplate(template)}
                                >
                                  Edit
                                </Button>
                                <Button
                                  kind="danger--ghost"
                                  size="sm"
                                  renderIcon={TrashCan}
                                  onClick={() => setDeletingTemplate(template)}
                                >
                                  Delete
                                </Button>
                              </RowActions>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            ))}
        </QueryBoundary>
      </div>
      {creating === 'scene' && <NewSceneModal onClose={() => setCreating(null)} />}
      {creating === 'playlist' && <NewPlaylistModal onClose={() => setCreating(null)} />}
      {editingTemplate && (
        <AnnouncementTemplateModal
          template={editingTemplate === 'new' ? undefined : editingTemplate}
          onClose={() => setEditingTemplate(null)}
        />
      )}
      {deletingTemplate && (
        <DeleteDialog
          title={`Delete “${deletingTemplate.name}”?`}
          noun="Template"
          confirmLabel="Delete template"
          remove={() =>
            deleteSignageAnnouncementTemplate(deletingTemplate.id, { expectedVersion: deletingTemplate.version })
          }
          onDeleted={() => setDeletingTemplate(null)}
          onClose={() => setDeletingTemplate(null)}
        >
          <p>
            Ended announcements made from it are removed too. A template that active announcements, display rules or
            scenes still use cannot be deleted. This cannot be undone.
          </p>
        </DeleteDialog>
      )}
    </PageShell>
  );
}
