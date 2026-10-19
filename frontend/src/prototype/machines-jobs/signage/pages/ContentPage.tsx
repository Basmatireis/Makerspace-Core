import { useState } from 'react';
import { Button, ClickableTile, Link as CarbonLink, OverflowMenu, OverflowMenuItem, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag } from '@carbon/react';
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
import { AnnouncementTemplateModal } from '../dialogs/AnnouncementTemplateModal';
import { DeleteTemplateModal } from '../dialogs/DeleteTemplateModal';
import { NewPlaylistModal, NewSceneModal } from '../dialogs/NewContentModals';
import { displayUsesPlaylist, formatLoop, loopSeconds, pluralize, sceneUsage } from '../helpers';
import { useSignage } from '../SignageContext';
import { useSignageQuery } from '../useSignageQuery';
import type { AnnouncementTemplate, Tone } from '../types';
import '../signage.scss';

const SECTIONS = [{ id: 'scenes', label: 'Scenes' }, { id: 'playlists', label: 'Playlists' }, { id: 'announcements', label: 'Announcements' }];
const TONE_TAG: Record<Tone, 'blue' | 'warm-gray' | 'red' | 'gray'> = { info: 'blue', warning: 'warm-gray', critical: 'red', neutral: 'gray' };
const TONE_LABEL: Record<Tone, string> = { info: 'Info', warning: 'Warning', critical: 'Critical', neutral: 'Neutral' };

export function ContentPage() {
  const store = useStore();
  const signage = useSignage();
  const navigate = useNavigate();
  const { params, update } = useUrlParams();
  const requested = params.get('section');
  const section = requested === 'playlists' || requested === 'announcements' ? requested : 'scenes';
  const [creating, setCreating] = useState<'scene' | 'playlist' | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<AnnouncementTemplate | 'new' | null>(null);
  const [deletingTemplate, setDeletingTemplate] = useState<AnnouncementTemplate | null>(null);
  const query = useSignageQuery({ scenes: signage.scenes, playlists: signage.playlists }, { scenes: [], playlists: [] });
  const canEdit = store.can('signage.content.manage');
  const { scenes, playlists } = query.data;

  const create = canEdit ? (
    <Button renderIcon={Add} onClick={() => { if (section === 'announcements') setEditingTemplate('new'); else setCreating(section === 'scenes' ? 'scene' : 'playlist'); }}>{section === 'scenes' ? 'New scene' : section === 'playlists' ? 'New playlist' : 'New template'}</Button>
  ) : undefined;

  return (
    <RequirePermission permission="signage.read" title="Content" crumbs={[{ label: 'Signage' }]}>
      <PageShell title="Content" description="Scenes are single screens built from a layout; playlists play scenes in a loop; announcement templates define live messages. Scene and playlist edits are drafts until a display is published." width="wide" breadcrumbs={[{ label: 'Signage' }]} actions={create}>
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
                          <div className="mj-inline"><Tag size="sm" type="cool-gray">{scene.orientation === 'portrait' ? 'Portrait' : 'Landscape'}</Tag></div>
                          <span className="mj-secondary">Used by {pluralize(usage.playlists, 'playlist')} · {pluralize(usage.rules, 'rule')}</span>
                        </div>
                      </ClickableTile>
                    );
                  })}
                </div>
              )
            ) : section === 'announcements' ? (
              signage.announcementTemplates.length === 0 ? <EmptyState title="No announcement templates yet" description="A template defines the fields and the message of a kind of announcement, such as “Closed”." action={create} /> : (
                <TableContainer className="mj-table-container">
                  <Table aria-label="Announcement templates">
                    <TableHead><TableRow><TableHeader>Name</TableHeader><TableHeader>Tone</TableHeader><TableHeader className="mj-hide-narrow">Message</TableHeader><TableHeader className="mj-hide-narrow">Fields</TableHeader><TableHeader>In use</TableHeader>{canEdit && <TableHeader><span className="cds--visually-hidden">Actions</span></TableHeader>}</TableRow></TableHead>
                    <TableBody>
                      {signage.announcementTemplates.map((template) => {
                        const inUse = signage.announcements.filter((item) => item.templateId === template.id && (!item.endsAt || Date.parse(item.endsAt) > Date.now())).length;
                        return (
                          <TableRow key={template.id} className={canEdit ? 'mj-table-row' : undefined} onClick={canEdit ? () => setEditingTemplate(template) : undefined}>
                            <TableCell>{canEdit ? <CarbonLink href="#" onClick={(event: React.MouseEvent) => { event.preventDefault(); event.stopPropagation(); setEditingTemplate(template); }}>{template.name}</CarbonLink> : template.name}</TableCell>
                            <TableCell><Tag size="sm" type={TONE_TAG[template.tone]}>{TONE_LABEL[template.tone]}</Tag></TableCell>
                            <TableCell className="mj-hide-narrow">{template.title}</TableCell>
                            <TableCell className="mj-hide-narrow">{template.fields.length === 0 ? '—' : template.fields.map((field) => field.label).join(', ')}</TableCell>
                            <TableCell>{inUse === 0 ? <span className="mj-secondary">Not in use</span> : pluralize(inUse, 'announcement')}</TableCell>
                            {canEdit && (
                              <TableCell className="cds--table-column-menu" onClick={(event) => event.stopPropagation()}>
                                <OverflowMenu size="sm" flipped aria-label={`Actions for ${template.name}`} iconDescription={`Actions for ${template.name}`}>
                                  <OverflowMenuItem itemText="Edit" onClick={() => setEditingTemplate(template)} />
                                  <OverflowMenuItem itemText="Delete" isDelete hasDivider onClick={() => setDeletingTemplate(template)} />
                                </OverflowMenu>
                              </TableCell>
                            )}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
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
        {deletingTemplate && <DeleteTemplateModal template={deletingTemplate} onClose={() => setDeletingTemplate(null)} />}
        {editingTemplate && <AnnouncementTemplateModal template={editingTemplate === 'new' ? undefined : editingTemplate} onClose={() => setEditingTemplate(null)} />}
      </PageShell>
    </RequirePermission>
  );
}
