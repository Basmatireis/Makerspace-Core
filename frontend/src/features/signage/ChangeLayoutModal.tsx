import { useState } from 'react';
import { InlineNotification, Modal, Stack } from '@carbon/react';
import type { SignageCustomLayout, SignageOrientation } from '../../api/generated/models';
import { LayoutPicker, type LayoutChoice } from './components';
import { samePickedLayout } from './customLayoutModel';

export function ChangeLayoutModal({
  sceneName,
  current,
  customLayouts,
  orientation,
  onSave,
  onClose,
}: {
  sceneName: string;
  current: LayoutChoice;
  customLayouts: readonly SignageCustomLayout[];
  orientation: SignageOrientation;
  onSave: (choice: LayoutChoice) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(current);
  return (
    <Modal
      open
      size="md"
      modalHeading="Change layout"
      modalLabel={sceneName}
      primaryButtonText="Change layout"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={samePickedLayout(selected, current)}
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
        <LayoutPicker value={selected} orientation={orientation} customLayouts={customLayouts} onChange={setSelected} />
      </Stack>
    </Modal>
  );
}
