import { InlineNotification, Modal } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { Organization } from '../../api/generated/models';
import { deleteOrganization } from '../../api/generated/organizations/organizations';
import { ApiError } from '../../api/http-client';
import { machineLogbookKeys } from '../machinelogbook/queries';
import { useNotify } from '../machinelogbook/shared/toasts';
import { organizationKeys } from './queries';
import { organizationPaths } from './presentation';

type Props = { organization: Organization; open: boolean; onClose: () => void };

/** Mount only while open so a previous error never shows in a fresh dialog. */
export function DeleteOrganizationModal({ organization, open, onClose }: Props) {
  if (!open) return null;
  return <DeleteOrganizationDialog organization={organization} onClose={onClose} />;
}

function DeleteOrganizationDialog({ organization, onClose }: Omit<Props, 'open'>) {
  const client = useQueryClient();
  const notify = useNotify();
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () => deleteOrganization(organization.id, { expectedVersion: organization.version }),
    onSuccess: async () => {
      client.removeQueries({ queryKey: organizationKeys.detail(organization.id) });
      await Promise.all([
        client.invalidateQueries({ queryKey: organizationKeys.all }),
        client.invalidateQueries({ queryKey: machineLogbookKeys.all }),
      ]);
      notify({ kind: 'success', title: 'Organization deleted', subtitle: `${organization.name} was deleted.` });
      onClose();
      navigate(organizationPaths.list());
    },
  });
  const code = remove.error instanceof ApiError ? remove.error.data?.code : undefined;
  const inUse = code === 'organization_in_use';
  const stale = code === 'stale_write';
  return (
    <Modal
      open danger alert modalHeading="Delete this organization?" primaryButtonText={remove.isPending ? 'Deleting…' : 'Delete organization'} secondaryButtonText="Cancel"
      primaryButtonDisabled={remove.isPending || inUse} preventCloseOnClickOutside selectorPrimaryFocus=".cds--btn--secondary" shouldSubmitOnEnter={false}
      onRequestClose={() => { if (!remove.isPending) onClose(); }} onSecondarySubmit={() => { if (!remove.isPending) onClose(); }}
      onRequestSubmit={() => { if (!remove.isPending && !inUse) remove.mutate(); }}
    >
      <p>
        {organization.name} will be deleted permanently together with its people list, pricing group assignment and invoicing settings. This cannot be undone.
      </p>
      {inUse && (
        <InlineNotification
          kind="error" lowContrast hideCloseButton title="Organization is in use"
          subtitle="Jobs, orders or invoice requests refer to this organization, so it cannot be deleted. Deactivate it instead to hide it from new billing selections."
        />
      )}
      {stale && <InlineNotification kind="error" lowContrast hideCloseButton title="Organization changed" subtitle="Someone else changed this organization. Reload the page and try again." />}
      {remove.isError && !inUse && !stale && <InlineNotification kind="error" lowContrast hideCloseButton title="Delete failed" subtitle="The organization could not be deleted. Reload the page and try again." />}
    </Modal>
  );
}
