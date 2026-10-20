import { InlineNotification, Modal } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { deleteMaterialType } from '../../../api/generated/inventory/inventory';
import type { MaterialType } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { machineLogbookKeys } from '../queries';
import { useNotify } from '../shared/toasts';

/** Mount only while open so an earlier error never shows in a fresh dialog. */
export function DeleteMaterialTypeModal({
  materialType,
  onClose,
}: {
  materialType: MaterialType;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const notify = useNotify();
  const remove = useMutation({
    mutationFn: () => deleteMaterialType(materialType.id, { expectedVersion: materialType.version }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({ kind: 'success', title: 'Material type deleted', subtitle: materialType.name });
      onClose();
    },
  });
  const code = remove.error instanceof ApiError ? remove.error.data?.code : undefined;
  const inUse = code === 'material_type_in_use';
  return (
    <Modal
      open
      danger
      alert
      modalHeading="Delete this material type?"
      primaryButtonText={remove.isPending ? 'Deleting…' : 'Delete material type'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={remove.isPending || inUse}
      preventCloseOnClickOutside
      selectorPrimaryFocus=".cds--btn--secondary"
      shouldSubmitOnEnter={false}
      onRequestClose={() => {
        if (!remove.isPending) onClose();
      }}
      onSecondarySubmit={() => {
        if (!remove.isPending) onClose();
      }}
      onRequestSubmit={() => {
        if (!remove.isPending && !inUse) remove.mutate();
      }}
    >
      <p>{materialType.name} will be deleted permanently. This cannot be undone.</p>
      {inUse && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Material type is in use"
          subtitle="Materials or pricing rules use this type, so it cannot be deleted. Deactivate it instead to stop using it for new materials."
        />
      )}
      {remove.isError && !inUse && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Delete failed"
          subtitle="The material type could not be deleted. Reload the page and try again."
        />
      )}
    </Modal>
  );
}
