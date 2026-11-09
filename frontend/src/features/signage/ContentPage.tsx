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
import { Add, Copy, Edit, TrashCan } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { SignageAnnouncementTemplate, SignageTone } from '../../api/generated/models';
import {
  deleteSignageAnnouncementTemplate,
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
import { aspectLabel, orientationOf, pluralize } from './helpers';
import { NewSceneModal } from './NewContentModals';
import { signagePaths } from './paths';
import { CustomLayoutsTable } from './CustomLayoutsTable';
import { customLayoutsQuery } from './layoutQueries';
import { announcementsQuery, scenesQuery, templatesQuery } from './queries';

type Section = 'scenes' | 'announcements' | 'layouts';
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'scenes', label: 'Scenes' },
  { id: 'announcements', label: 'Announcements' },
  { id: 'layouts', label: 'Layouts' },
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
  const section: Section = requested === 'announcements' || requested === 'layouts' ? requested : 'scenes';
  const [creating, setCreating] = useState<'scene' | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<SignageAnnouncementTemplate | 'new' | null>(null);
  const [deletingTemplate, setDeletingTemplate] = useState<SignageAnnouncementTemplate | null>(null);
  const duplicateScene = useDuplicate(duplicateSignageScene, (copy) => void navigate(signagePaths.scene(copy.id)));
  const duplicateTemplate = useDuplicate(duplicateSignageAnnouncementTemplate, (copy) => setEditingTemplate(copy));
  const scenes = useQuery(scenesQuery());
  const templates = useQuery(templatesQuery());
  const announcements = useQuery(announcementsQuery());
  const layouts = useQuery(customLayoutsQuery());
  const query = section === 'scenes' ? scenes : section === 'layouts' ? layouts : templates;

  const createLabel = section === 'scenes' ? 'New scene' : section === 'layouts' ? 'New layout' : 'New template';
  const create = canEdit ? (
    <Button
      renderIcon={Add}
      onClick={() => {
        if (section === 'announcements') setEditingTemplate('new');
        else if (section === 'layouts') void navigate(signagePaths.newLayout);
        else setCreating('scene');
      }}
    >
      {createLabel}
    </Button>
  ) : undefined;
  const open = (event: { preventDefault: () => void }, to: string) => {
    event.preventDefault();
    void navigate(to);
  };

  return (
    <PageShell title="Content" width="wide" breadcrumbs={[{ label: 'Signage' }]} actions={create}>
      <div className="sg-stack">
        <SectionSwitcher
          label="Content type"
          sections={SECTIONS}
          selected={section}
          onChange={(id) => setParams(id === 'scenes' ? {} : { section: id }, { replace: true })}
        />
        {duplicateScene.error}
        {duplicateTemplate.error}
        <QueryBoundary
          query={query}
          label={section === 'scenes' ? 'scenes' : section === 'layouts' ? 'layouts' : 'announcement templates'}
        >
          {section === 'layouts' && (
            <CustomLayoutsTable layouts={layouts.data?.items ?? []} canEdit={canEdit} create={create} />
          )}
          {section === 'scenes' &&
            (scenes.data?.items.length === 0 ? (
              <EmptyState
                title="No scenes yet"
                description="A scene fills the screen with one layout and a widget per zone."
                action={create}
              />
            ) : (
              <div className="sg-tile-grid">
                {scenes.data?.items.map((scene) => (
                  <div key={scene.id} className="sg-scene-card">
                    <ClickableTile
                      className="sg-scene-tile"
                      href={signagePaths.scene(scene.id)}
                      aria-label={`Scene ${scene.name}`}
                      onClick={(event: { preventDefault: () => void }) => open(event, signagePaths.scene(scene.id))}
                    >
                      <div className={`sg-scene-tile__thumb sg-scene-tile__thumb--${orientationOf(scene.aspectRatio)}`}>
                        <SceneThumbnail scene={scene} />
                      </div>
                      <div className="sg-scene-tile__text">
                        <strong>{scene.name}</strong>
                        <div className="sg-inline">
                          <Tag size="sm" type="cool-gray">
                            {aspectLabel(scene.aspectRatio)}
                          </Tag>
                        </div>
                      </div>
                    </ClickableTile>
                    {canEdit && (
                      <Button
                        kind="ghost"
                        size="sm"
                        renderIcon={Copy}
                        disabled={duplicateScene.pending}
                        onClick={() => duplicateScene.duplicate(scene.id)}
                      >
                        Duplicate
                        <span className="cds--visually-hidden"> {scene.name}</span>
                      </Button>
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
