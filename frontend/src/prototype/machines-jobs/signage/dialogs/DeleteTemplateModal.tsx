import { Link as CarbonLink, ListItem, Modal, Stack, UnorderedList } from '@carbon/react';
import { Link } from 'react-router-dom';
import { DestructiveActionDialog } from '../../../../app/DestructiveActionDialog';
import { useStore } from '../../store';
import { announcementTemplateUsage, pluralize, templateInUse } from '../helpers';
import { useSignage } from '../SignageContext';
import type { AnnouncementTemplate } from '../types';

/** Deletes an announcement template, or explains what still uses it. Any use blocks deletion so no rule or widget changes meaning silently. */
export function DeleteTemplateModal({ template, onClose }: { template: AnnouncementTemplate; onClose: () => void }) {
  const signage = useSignage();
  const store = useStore();
  const usage = announcementTemplateUsage(template.id, { announcements: signage.announcements, displays: signage.displays, scenes: signage.scenes });

  if (templateInUse(usage)) {
    return (
      <Modal open passiveModal size="sm" modalHeading={`“${template.name}” is still in use`} modalLabel="Delete template" onRequestClose={onClose}>
        <Stack gap={5}>
          <p>Remove these uses first, then delete the template.</p>
          {usage.announcements.length > 0 && (
            <div>
              <h3 className="mj-section-title">{pluralize(usage.announcements.length, 'active or scheduled announcement')}</h3>
              <p className="mj-secondary">Stop them on <CarbonLink as={Link} to="/signage/announcements" onClick={onClose}>Announcements</CarbonLink>.</p>
            </div>
          )}
          {usage.rules.length > 0 && (
            <div>
              <h3 className="mj-section-title">Display rules</h3>
              <UnorderedList>
                {usage.rules.map(({ display, position }) => (
                  <ListItem key={`${display.id}-${position}`}><CarbonLink as={Link} to={`/signage/displays/${display.id}`} onClick={onClose}>{display.name}</CarbonLink>, rule {position}</ListItem>
                ))}
              </UnorderedList>
            </div>
          )}
          {usage.widgets.length > 0 && (
            <div>
              <h3 className="mj-section-title">Announcement zones in scenes</h3>
              <UnorderedList>
                {usage.widgets.map(({ scene, zoneLabel }) => (
                  <ListItem key={`${scene.id}-${zoneLabel}`}><CarbonLink as={Link} to={`/signage/scenes/${scene.id}`} onClick={onClose}>{scene.name}</CarbonLink>, zone {zoneLabel}</ListItem>
                ))}
              </UnorderedList>
            </div>
          )}
        </Stack>
      </Modal>
    );
  }

  return (
    <DestructiveActionDialog
      open title={`Delete “${template.name}”?`} confirmLabel="Delete template" onClose={onClose}
      onConfirm={() => {
        signage.deleteAnnouncementTemplate(template.id);
        store.notify({ kind: 'success', title: 'Template deleted', subtitle: template.name });
        onClose();
      }}
    >
      <p>Nothing uses this template. Ended announcements made from it are removed too. This cannot be undone.</p>
    </DestructiveActionDialog>
  );
}
