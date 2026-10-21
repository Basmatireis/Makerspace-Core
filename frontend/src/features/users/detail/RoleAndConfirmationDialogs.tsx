import {
  Accordion,
  AccordionItem,
  Button,
  ComposedModal,
  Dropdown,
  InlineNotification,
  ListItem,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Stack,
  TextInput,
  UnorderedList,
} from '@carbon/react';
import type { Person } from '../../../api/generated/models';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { formatDateTime } from '../../../app/dateTime';
import { InlineLoadingState } from '../../../app/PageState';
import type { PersonDetailActions } from './usePersonDetailActions';

/** Dialogs for assigning and removing roles, showing a manual setup link, and confirming destructive account actions. */
export function RoleAndConfirmationDialogs({ person, ctrl }: { person: Person; ctrl: PersonDetailActions }) {
  const {
    assignRoleOpen,
    setAssignRoleOpen,
    selectedRole,
    setSelectedRole,
    rolesQuery,
    assignableRoles,
    roleMutation,
    roleToRemove,
    setRoleToRemove,
    manualSetupUrl,
    resetExpiresAt,
    clearResetIssue,
    selectedConfirmation,
    closeConfirmation,
    confirmationErrors,
    resetFailed,
    confirmKind,
    removeAuthIdentityMutation,
    confirmationPending,
    confirmAction,
    setConfirmKind,
    setAuthIdentityToRemove,
  } = ctrl;

  return (
    <>
      <ComposedModal
        open={assignRoleOpen}
        onClose={() => {
          setSelectedRole(null);
          setAssignRoleOpen(false);
        }}
      >
        <ModalHeader title="Assign role" label={`${person.firstName} ${person.lastName}`} />
        <ModalBody>
          <Stack gap={5}>
            {rolesQuery.isPending && <InlineLoadingState label="Loading role catalog" />}
            {rolesQuery.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Role catalog unavailable"
                subtitle="Reload the person and try again."
              />
            )}
            {rolesQuery.data && assignableRoles.length === 0 && <p>No additional roles are available.</p>}
            {rolesQuery.data && assignableRoles.length > 0 && (
              <Dropdown
                autoAlign
                id="assign-role"
                titleText="Role"
                label="Choose a role"
                items={assignableRoles}
                itemToString={(item) => item?.name ?? ''}
                selectedItem={selectedRole}
                onChange={({ selectedItem }) => setSelectedRole(selectedItem ?? null)}
              />
            )}
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button
            kind="secondary"
            onClick={() => {
              setSelectedRole(null);
              setAssignRoleOpen(false);
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={!selectedRole || roleMutation.isPending}
            onClick={() => selectedRole && roleMutation.mutate({ roleId: selectedRole.id, remove: false })}
          >
            {roleMutation.isPending ? 'Assigning…' : 'Assign role'}
          </Button>
        </ModalFooter>
      </ComposedModal>

      <ComposedModal aria-label="Manual setup link created" open={Boolean(manualSetupUrl)} onClose={clearResetIssue}>
        <ModalHeader title="Manual setup link created" label={`${person.firstName} ${person.lastName}`} />
        <ModalBody>
          <Stack gap={5}>
            <p>Copy this one-time link and deliver it to the intended recipient through a trusted channel.</p>
            {manualSetupUrl && (
              <TextInput
                id="manual-setup-url"
                labelText="One-time setup link"
                readOnly
                value={`${window.location.origin}${manualSetupUrl}`}
              />
            )}
            {resetExpiresAt && <p className="section-description">Expires {formatDateTime(resetExpiresAt)}.</p>}
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" onClick={clearResetIssue}>
            Done
          </Button>
          <Button
            onClick={() =>
              manualSetupUrl && void navigator.clipboard.writeText(`${window.location.origin}${manualSetupUrl}`)
            }
          >
            Copy link
          </Button>
        </ModalFooter>
      </ComposedModal>

      <ComposedModal
        open={Boolean(selectedConfirmation)}
        danger
        selectorPrimaryFocus=".cds--btn--secondary"
        preventCloseOnClickOutside
        onClose={closeConfirmation}
      >
        <ModalHeader title={selectedConfirmation?.[0] ?? ''} />
        <ModalBody>
          <Stack gap={5}>
            <p>{selectedConfirmation?.[1]}</p>
            {confirmationErrors.length === 1 && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Action failed"
                subtitle={confirmationErrors[0]}
              />
            )}
            {confirmationErrors.length > 1 && (
              <Stack gap={3}>
                <InlineNotification
                  kind="error"
                  lowContrast
                  hideCloseButton
                  title="Deletion blocked"
                  subtitle={`${confirmationErrors.length} reasons prevent this deletion.`}
                />
                <Accordion isFlush size="sm">
                  <AccordionItem title="Show all reasons">
                    <UnorderedList>
                      {confirmationErrors.map((reason) => (
                        <ListItem key={reason}>{reason}</ListItem>
                      ))}
                    </UnorderedList>
                  </AccordionItem>
                </Accordion>
              </Stack>
            )}
            {resetFailed &&
              (confirmKind === 'reset-password' || confirmKind === 'invite' || confirmKind === 'pin-setup') && (
                <InlineNotification
                  kind="error"
                  lowContrast
                  hideCloseButton
                  title="Message not sent"
                  subtitle="Reload the account and try again."
                />
              )}
            {confirmKind === 'remove-auth-method' && removeAuthIdentityMutation.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Authentication method not removed"
                subtitle="The account may have changed. Reload it and try again."
              />
            )}
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button
            kind="secondary"
            disabled={confirmationPending}
            onClick={() => {
              setConfirmKind(null);
              setAuthIdentityToRemove(null);
              removeAuthIdentityMutation.reset();
            }}
          >
            Cancel
          </Button>
          <Button kind="danger" disabled={confirmationPending} onClick={() => void confirmAction()}>
            {confirmationPending
              ? `${selectedConfirmation?.[2] ?? 'Confirm'}…`
              : (selectedConfirmation?.[2] ?? 'Confirm')}
          </Button>
        </ModalFooter>
      </ComposedModal>

      <DestructiveActionDialog
        open={Boolean(roleToRemove)}
        title={`Remove ${roleToRemove?.name ?? 'role'}?`}
        confirmLabel="Remove role"
        pending={roleMutation.isPending}
        error={
          roleMutation.isError
            ? 'The role assignment may have changed, or removing it would violate the last-master or privilege rules.'
            : undefined
        }
        onClose={() => {
          setRoleToRemove(null);
          roleMutation.reset();
        }}
        onConfirm={() => roleToRemove && roleMutation.mutate({ roleId: roleToRemove.id, remove: true })}
      >
        <p>
          {roleToRemove?.name ?? 'This role'} will be removed from {person.firstName} {person.lastName}. Permissions
          granted by this role will no longer apply. The role itself and other members remain unchanged.
        </p>
      </DestructiveActionDialog>
    </>
  );
}
