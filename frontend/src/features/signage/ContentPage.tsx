import './styles.scss';
import { useState } from 'react';
import {
  Button,
  ClickableTile,
  Link as CarbonLink,
  OverflowMenu,
  OverflowMenuItem,
  Search,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import { Add, Copy, Edit, TrashCan } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { SignageAnnouncementTemplate, SignageScene, SignageTone } from '../../api/generated/models';
import {
  deleteSignageAnnouncementTemplate,
  deleteSignageScene,
  duplicateSignageAnnouncementTemplate,
  duplicateSignageScene,
} from '../../api/generated/signage/signage';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { RowActions } from '../../app/RowActions';
import { SectionSwitcher } from '../../app/SectionSwitcher';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { AnnouncementTemplateModal } from './AnnouncementTemplateModal';
import { useDuplicate } from './duplicate';
import { DeleteDialog, QueryBoundary, SceneThumbnail } from './components';
import { shapeName } from './aspectFields';
import { aspectLabel, orientationOf, pluralize } from './helpers';
import { NewSceneModal } from './NewContentModals';
import { signagePaths } from './paths';
import { announcementsQuery, scenesQuery, templatesQuery } from './queries';

type Section = 'scenes' | 'announcements';
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'scenes', label: 'Screens' },
  { id: 'announcements', label: 'Announcement templates' },
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
  const section: Section = requested === 'announcements' ? requested : 'scenes';
  const [creating, setCreating] = useState<'scene' | null>(null);
  const [search, setSearch] = useState('');
  const [deletingScene, setDeletingScene] = useState<SignageScene | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<SignageAnnouncementTemplate | 'new' | null>(null);
  const [deletingTemplate, setDeletingTemplate] = useState<SignageAnnouncementTemplate | null>(null);
  const duplicateScene = useDuplicate(duplicateSignageScene, (copy) => void navigate(signagePaths.scene(copy.id)));
  const duplicateTemplate = useDuplicate(duplicateSignageAnnouncementTemplate, (copy) => setEditingTemplate(copy));
  const scenes = useQuery(scenesQuery());
  const templates = useQuery(templatesQuery());
  const announcements = useQuery(announcementsQuery());
  const query = section === 'scenes' ? scenes : templates;

  const newScreen = canEdit ? (
    <Button renderIcon={Add} onClick={() => setCreating('scene')}>
      New screen
    </Button>
  ) : undefined;
  const newTemplate = canEdit ? (
    <Button renderIcon={Add} onClick={() => setEditingTemplate('new')}>
      New template
    </Button>
  ) : undefined;
  const needle = search.trim().toLowerCase();
  const shownScenes = (scenes.data?.items ?? []).filter((scene) =>
    needle
      .split(/\s+/)
      .every((word) =>
        `${scene.name} ${aspectLabel(scene.aspectRatio)} ${shapeName(scene.aspectRatio)}`.toLowerCase().includes(word),
      ),
  );
  const open = (event: { preventDefault: () => void }, to: string) => {
    event.preventDefault();
    void navigate(to);
  };

  return (
    <PageShell
      title="Screens"
      width="wide"
      breadcrumbs={[{ label: 'Signage' }]}
      actions={section === 'announcements' ? newTemplate : undefined}
    >
      <div className="sg-stack">
        <SectionSwitcher
          label="Screens and announcement templates"
          sections={SECTIONS}
          selected={section}
          onChange={(id) => setParams(id === 'scenes' ? {} : { section: id }, { replace: true })}
        />
        {duplicateScene.error}
        {duplicateTemplate.error}
        {section === 'scenes' && (
          <div className="sg-screens-toolbar">
            <Search
              size="lg"
              labelText="Search screens"
              placeholder="Search screens"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {newScreen}
          </div>
        )}
        <QueryBoundary query={query} label={section === 'scenes' ? 'screens' : 'announcement templates'}>
          {section === 'scenes' &&
            (scenes.data?.items.length === 0 ? (
              <EmptyState
                title="No screens yet"
                description="A screen fills a display with blocks: text, images, video, live data and more."
                action={newScreen}
              />
            ) : shownScenes.length === 0 ? (
              <EmptyState title="No screens match" description="Try another name or shape." />
            ) : (
              <div className="sg-tile-grid">
                {shownScenes.map((scene) => (
                  <div key={scene.id} className="sg-scene-card">
                    <ClickableTile
                      className="sg-scene-tile"
                      href={signagePaths.scene(scene.id)}
                      aria-label={`Screen ${scene.name}`}
                      onClick={(event: { preventDefault: () => void }) => open(event, signagePaths.scene(scene.id))}
                    >
                      <div className={`sg-scene-tile__thumb sg-scene-tile__thumb--${orientationOf(scene.aspectRatio)}`}>
                        <SceneThumbnail scene={scene} />
                      </div>
                      <div className="sg-scene-tile__text">
                        <strong>{scene.name}</strong>
                        <div className="sg-inline">
                          <Tag size="sm" type="cool-gray">
                            {shapeName(scene.aspectRatio)} {aspectLabel(scene.aspectRatio)}
                          </Tag>
                        </div>
                      </div>
                    </ClickableTile>
                    {canEdit && (
                      <div className="sg-scene-card__menu">
                        <OverflowMenu
                          size="md"
                          flipped
                          aria-label={`Actions for ${scene.name}`}
                          iconDescription={`Actions for ${scene.name}`}
                        >
                          <OverflowMenuItem
                            itemText="Duplicate"
                            disabled={duplicateScene.pending}
                            onClick={() => duplicateScene.duplicate(scene.id)}
                          />
                          <OverflowMenuItem
                            itemText="Delete"
                            isDelete
                            hasDivider
                            onClick={() => setDeletingScene(scene)}
                          />
                        </OverflowMenu>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          {section === 'announcements' &&
            (templates.data?.items.length === 0 ? (
              <EmptyState
                title="No announcement templates yet"
                description="A template defines the fields and the message of a kind of announcement, such as “Closed”."
                action={newTemplate}
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
                                  kind="ghost"
                                  size="sm"
                                  renderIcon={Copy}
                                  disabled={duplicateTemplate.pending}
                                  onClick={() => duplicateTemplate.duplicate(template.id)}
                                >
                                  Duplicate
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
      {deletingScene && (
        <DeleteDialog
          title={`Delete “${deletingScene.name}”?`}
          noun="Screen"
          confirmLabel="Delete screen"
          remove={() => deleteSignageScene(deletingScene.id, { expectedVersion: deletingScene.version })}
          onDeleted={() => setDeletingScene(null)}
          onClose={() => setDeletingScene(null)}
        >
          <p>
            The screen is removed for good. A screen that a display's default screens or rules still use cannot be
            deleted.
          </p>
        </DeleteDialog>
      )}
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
            scenes still use cannot be deleted.
          </p>
        </DeleteDialog>
      )}
    </PageShell>
  );
}
