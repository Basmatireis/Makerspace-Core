import { useState } from 'react';
import { InlineNotification, Modal, Stack } from '@carbon/react';
import type { SignageLayoutId, SignageOrientation } from '../../api/generated/models';
import { LayoutPicker } from './components';

export function ChangeLayoutModal({
  sceneName,
  layoutId,
  orientation,
  onSave,
  onClose,
}: {
  sceneName: string;
  layoutId: SignageLayoutId;
  orientation: SignageOrientation;
  onSave: (layoutId: SignageLayoutId) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(layoutId);
  return (
    <Modal
      open
      size="md"
      modalHeading="Change layout"
      modalLabel={sceneName}
      primaryButtonText="Change layout"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={selected === layoutId}
      preventCloseOnClickOutside
      onRequestClose={onClose}
      onRequestSubmit={() => {
        onSave(selected);
        onClose();
      }}
    >
      <Stack gap={5}>
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Widgets keep their position"
          subtitle="The first zone of the new layout takes the widget of the first zone of the old one, and so on. Extra widgets are dropped."
        />
        <LayoutPicker value={selected} orientation={orientation} onChange={setSelected} />
      </Stack>
    </Modal>
  );
}
