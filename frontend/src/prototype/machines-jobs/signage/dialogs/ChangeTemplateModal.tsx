import { useState } from 'react';
import { InlineNotification, Modal, Stack } from '@carbon/react';
import { TemplatePicker } from '../components/TemplatePicker';
import type { Scene } from '../types';

export function ChangeTemplateModal({ scene, onSave, onClose }: { scene: Scene; onSave: (templateId: string) => void; onClose: () => void }) {
  const [templateId, setTemplateId] = useState(scene.templateId);
  return (
    <Modal open size="md" modalHeading="Change template" modalLabel={scene.name} primaryButtonText="Change template" secondaryButtonText="Cancel" primaryButtonDisabled={templateId === scene.templateId} preventCloseOnClickOutside onRequestClose={onClose} onRequestSubmit={() => { onSave(templateId); onClose(); }}>
      <Stack gap={5}>
        <InlineNotification kind="info" lowContrast hideCloseButton title="Widgets keep their position" subtitle="The first zone of the new layout takes the widget of the first zone of the old one, and so on. Extra widgets are dropped." />
        <TemplatePicker value={templateId} orientation={scene.orientation} onChange={setTemplateId} />
      </Stack>
    </Modal>
  );
}
