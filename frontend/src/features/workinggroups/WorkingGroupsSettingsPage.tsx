import { useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Button, InlineNotification, Modal, Stack, TextArea, TextInput } from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { WorkingGroup } from '../../api/generated/models';
import { createWorkingGroup, deleteWorkingGroup } from '../../api/generated/working-groups/working-groups';
import { apiErrorCode } from '../../api/http-client';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { EmptyState, ErrorState } from '../../app/PageState';
import { useNotify } from '../../app/toasts';
import { useCurrentUser } from '../auth/auth';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { SettingsLoading, SettingsPageLayout, SettingsSection } from '../settings/SettingsPageLayout';
import { SettingsTabs } from '../settings/SettingsTabs';
import { GroupForm, MachinesAndPlacesSection, PeopleSection } from './GroupSections';
import { WorkingGroupPersonCombo, type PersonChoice } from './WorkingGroupPersonCombo';
import {
  canManageWorkingGroups,
  editableWorkingGroups,
  workingGroupKeys,
  workingGroupOptions,
  workingGroupsOptions,
} from './queries';
import './workinggroups.scss';

/** Settings → Working groups: leads maintain their own group, management also creates, renames and deletes groups. */
export function WorkingGroupsSettingsPage() {
  const currentUser = useCurrentUser();
  const [, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const closeCreate = () => {
    setCreating(false);
    // The modal unmounts, so focus goes back to the button that opened it.
    window.setTimeout(() => newButtonRef.current?.focus(), 0);
  };
  const list = useQuery(workingGroupsOptions);
  const canManage = canManageWorkingGroups(currentUser);
  const editable = editableWorkingGroups(currentUser, list.data?.items ?? []).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return (
    <SettingsPageLayout
      page="working-groups"
      width="wide"
      breadcrumbs={canManage ? undefined : [{ label: 'Working groups', to: '/working-groups' }]}
      actions={
        canManage && (
          <Button ref={newButtonRef} renderIcon={Add} onClick={() => setCreating(true)}>
            New working group
          </Button>
        )
      }
    >
      {list.isPending && <SettingsLoading label="Loading working groups" />}
      {list.isError && <ErrorState title="Working groups unavailable" message="Reload the page to try again." />}
      {list.isSuccess && editable.length === 0 && (
        <EmptyState
          title={canManage ? 'No working groups yet' : 'No group to edit'}
          description={
            canManage
              ? 'Create the first working group to assign a lead, machines and places.'
              : 'You can edit the groups you lead. Management can make you the lead of a group.'
          }
        />
      )}
      {list.isSuccess && editable.length > 0 && (
        <SettingsTabs
          label="Working groups"
          tabs={editable.map((group) => ({
            key: group.id,
            label: group.name,
            panel: <GroupPanel key={group.id} groupId={group.id} />,
          }))}
        />
      )}
      {creating && (
        <CreateGroupModal
          onClose={closeCreate}
          onCreated={(group) => {
            closeCreate();
            setParams({ tab: group.id }, { replace: true });
          }}
        />
      )}
    </SettingsPageLayout>
  );
}

function GroupPanel({ groupId }: { groupId: string }) {
  const detail = useQuery(workingGroupOptions(groupId));
  return (
    <QueryBoundary query={detail} errorMessage="The working group could not be loaded.">
      {(group) => (
        <Stack gap={8}>
          <GroupForm key={group.version} group={group} />
          <PeopleSection group={group} />
          <MachinesAndPlacesSection key={group.machines.map((machine) => machine.id).join()} group={group} />
          {group.canManage && <DeleteGroupSection group={group} />}
        </Stack>
      )}
    </QueryBoundary>
  );
}

function DeleteGroupSection({ group }: { group: WorkingGroup }) {
  const client = useQueryClient();
  const notify = useNotify();
  const [confirming, setConfirming] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const remove = useMutation({
    mutationFn: () => deleteWorkingGroup(group.id),
    onSuccess: async () => {
      setConfirming(false);
      await client.invalidateQueries({ queryKey: workingGroupKeys.all });
      notify({ kind: 'success', title: 'Group deleted', subtitle: group.name });
    },
  });
  return (
    <SettingsSection title="Delete group">
      <Button
        ref={launcherRef}
        kind="danger--tertiary"
        renderIcon={TrashCan}
        onClick={() => {
          remove.reset();
          setConfirming(true);
        }}
      >
        Delete group
      </Button>
      <DestructiveActionDialog
        open={confirming}
        title="Delete group"
        fate="permanent"
        confirmLabel="Delete group"
        pending={remove.isPending}
        launcherButtonRef={launcherRef}
        error={remove.isError ? 'Check your connection and try again.' : undefined}
        onConfirm={() => remove.mutate()}
        onClose={() => setConfirming(false)}
      >
        <p>
          {group.name} is deleted with its memberships, machine assignments and places. The machines and people
          themselves stay.
        </p>
      </DestructiveActionDialog>
    </SettingsSection>
  );
}

type CreateValues = { name: string; description: string; lead: PersonChoice | null };

function CreateGroupModal({ onClose, onCreated }: { onClose: () => void; onCreated: (group: WorkingGroup) => void }) {
  const client = useQueryClient();
  const notify = useNotify();
  const { control, handleSubmit } = useForm<CreateValues>({ defaultValues: { name: '', description: '', lead: null } });
  const create = useMutation({
    mutationFn: (values: CreateValues) =>
      createWorkingGroup({
        name: values.name.trim(),
        description: values.description.trim(),
        leadPersonId: values.lead!.id,
      }),
    onSuccess: async (group) => {
      await client.invalidateQueries({ queryKey: workingGroupKeys.all });
      notify({ kind: 'success', title: 'Working group created', subtitle: group.name });
      onCreated(group);
    },
  });
  const nameTaken = apiErrorCode(create.error) === 'working_group_exists';
  const submit = handleSubmit((values) => create.mutate(values));
  return (
    <Modal
      open
      size="sm"
      modalHeading="New working group"
      primaryButtonText={create.isPending ? 'Creating…' : 'Create group'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={create.isPending}
      preventCloseOnClickOutside
      shouldSubmitOnEnter={false}
      onRequestClose={() => {
        if (!create.isPending) onClose();
      }}
      onRequestSubmit={() => void submit()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Stack gap={6}>
          {create.isError && !nameTaken && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Group not created"
              subtitle="Check the fields and your connection, then try again."
            />
          )}
          <Controller
            control={control}
            name="name"
            rules={{
              validate: (value) => (value.trim() !== '' && value.trim().length <= 80) || 'Enter up to 80 characters.',
            }}
            render={({ field, fieldState }) => (
              <TextInput
                id="wg-new-name"
                labelText="Name"
                invalid={Boolean(fieldState.error) || nameTaken}
                invalidText={fieldState.error?.message ?? 'A working group with this name already exists.'}
                {...field}
              />
            )}
          />
          <Controller
            control={control}
            name="description"
            rules={{ maxLength: { value: 500, message: 'Enter up to 500 characters.' } }}
            render={({ field, fieldState }) => (
              <TextArea
                id="wg-new-description"
                labelText="What the group looks after"
                rows={3}
                invalid={Boolean(fieldState.error)}
                invalidText={fieldState.error?.message}
                {...field}
              />
            )}
          />
          <Controller
            control={control}
            name="lead"
            rules={{ validate: (value) => value !== null || 'Choose the group lead.' }}
            render={({ field, fieldState }) => (
              <WorkingGroupPersonCombo
                id="wg-new-lead"
                titleText="Group lead"
                helperText="The lead becomes the first member."
                value={field.value}
                onChange={field.onChange}
                invalid={Boolean(fieldState.error)}
                invalidText={fieldState.error?.message}
              />
            )}
          />
        </Stack>
      </form>
    </Modal>
  );
}
