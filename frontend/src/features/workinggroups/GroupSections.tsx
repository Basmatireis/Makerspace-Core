import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
  Button,
  InlineNotification,
  MultiSelect,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TextArea,
  TextInput,
} from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkingGroup, WorkingGroupMachineOption } from '../../api/generated/models';
import {
  addWorkingGroupMember,
  addWorkingGroupPlace,
  removeWorkingGroupMember,
  removeWorkingGroupPlace,
  setWorkingGroupLead,
  setWorkingGroupMachines,
  updateWorkingGroup,
} from '../../api/generated/working-groups/working-groups';
import { ApiError, apiErrorCode } from '../../api/http-client';
import { useNotify } from '../../app/toasts';
import { SettingsSection } from '../settings/SettingsPageLayout';
import { WorkingGroupPersonCombo, type PersonChoice } from './WorkingGroupPersonCombo';
import { workingGroupKeys, workingGroupMachinesOptions } from './queries';
import './workinggroups.scss';

const staleMessage = 'Someone else changed this group. The latest values are shown; make your change again.';
const genericMessage = 'Check your connection and try again.';

function useInvalidate() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: workingGroupKeys.all });
}

/** Maps the common failures of the group endpoints; `specific` holds the codes of the calling section. */
function failure(error: unknown, specific: Record<string, string> = {}): string {
  const code = apiErrorCode(error);
  if (code && specific[code]) return specific[code];
  if (code === 'stale_write') return staleMessage;
  if (error instanceof ApiError && error.status === 403) return 'You may not change this group.';
  if (error instanceof ApiError && error.status === 422) return 'Check the fields and try again.';
  return genericMessage;
}

function Failure({ title, error, specific }: { title: string; error: unknown; specific?: Record<string, string> }) {
  if (!error) return null;
  return (
    <InlineNotification kind="error" lowContrast hideCloseButton title={title} subtitle={failure(error, specific)} />
  );
}

type GroupValues = { name: string; description: string; chatUrl: string };

function validChatUrl(value: string): true | string {
  const text = value.trim();
  if (text === '') return true;
  try {
    return new URL(text).protocol === 'https:' || 'Enter a link that starts with https://.';
  } catch {
    return 'Enter a link that starts with https://.';
  }
}

/** Name (management only), description and chat link, saved with the version the form was loaded with. */
export function GroupForm({ group }: { group: WorkingGroup }) {
  const invalidate = useInvalidate();
  const notify = useNotify();
  const { control, handleSubmit } = useForm<GroupValues>({
    defaultValues: { name: group.name, description: group.description, chatUrl: group.chatUrl ?? '' },
  });
  const save = useMutation({
    mutationFn: (values: GroupValues) =>
      updateWorkingGroup(group.id, {
        expectedVersion: group.version,
        ...(group.canManage ? { name: values.name.trim() } : {}),
        description: values.description.trim(),
        chatUrl: values.chatUrl.trim() || null,
      }),
    onSuccess: async () => {
      await invalidate();
      notify({ kind: 'success', title: 'Group saved' });
    },
    onError: () => void invalidate(),
  });
  return (
    <SettingsSection title="Group">
      <form className="wg-form" onSubmit={(event) => void handleSubmit((values) => save.mutate(values))(event)}>
        <Stack gap={6}>
          <Failure
            title="Group not saved"
            error={save.error}
            specific={{ working_group_exists: 'A working group with this name already exists.' }}
          />
          <Controller
            control={control}
            name="name"
            rules={{
              validate: (value) =>
                (value.trim() !== '' && value.trim().length <= 80) || 'Enter a name of up to 80 characters.',
            }}
            render={({ field, fieldState }) => (
              <TextInput
                id={`wg-name-${group.id}`}
                labelText="Name"
                helperText={group.canManage ? undefined : 'Only management renames a group.'}
                readOnly={!group.canManage}
                invalid={Boolean(fieldState.error) || apiErrorCode(save.error) === 'working_group_exists'}
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
                id={`wg-description-${group.id}`}
                labelText="What the group looks after"
                rows={3}
                maxCount={500}
                enableCounter
                invalid={Boolean(fieldState.error)}
                invalidText={fieldState.error?.message}
                {...field}
              />
            )}
          />
          <Controller
            control={control}
            name="chatUrl"
            rules={{ validate: validChatUrl }}
            render={({ field, fieldState }) => (
              <TextInput
                id={`wg-chat-${group.id}`}
                labelText="Link to the group chat"
                helperText="Only members see the link."
                placeholder="https://"
                invalid={Boolean(fieldState.error)}
                invalidText={fieldState.error?.message}
                {...field}
              />
            )}
          />
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </Stack>
      </form>
    </SettingsSection>
  );
}

/** Members with Remove, the add-a-member field and, for management, the lead picker. */
export function PeopleSection({ group }: { group: WorkingGroup }) {
  const invalidate = useInvalidate();
  const notify = useNotify();
  const [newMember, setNewMember] = useState<PersonChoice | null>(null);
  const [newLead, setNewLead] = useState<PersonChoice | null>(null);
  const memberChoices = group.members.map((member) => ({ id: member.personId, label: member.displayName }));
  const add = useMutation({
    mutationFn: (person: PersonChoice) => addWorkingGroupMember(group.id, { personId: person.id }),
    onSuccess: async (_, person) => {
      setNewMember(null);
      await invalidate();
      notify({ kind: 'success', title: 'Member added', subtitle: person.label });
    },
    onError: () => void invalidate(),
  });
  const remove = useMutation({
    mutationFn: (personId: string) => removeWorkingGroupMember(group.id, personId),
    onSettled: () => invalidate(),
  });
  const lead = useMutation({
    mutationFn: (person: PersonChoice) => setWorkingGroupLead(group.id, { personId: person.id }),
    onSuccess: async (_, person) => {
      setNewLead(null);
      await invalidate();
      notify({ kind: 'success', title: 'Group lead changed', subtitle: person.label });
    },
    onError: () => void invalidate(),
  });
  return (
    <SettingsSection title="People">
      <Stack gap={6}>
        <Failure
          title="Member not removed"
          error={remove.error}
          specific={{ working_group_lead_required: 'The lead stays a member. Choose another lead first.' }}
        />
        <Table aria-label="Members" size="md">
          <TableHead>
            <TableRow>
              <TableHeader>Name</TableHeader>
              <TableHeader>Role</TableHeader>
              <TableHeader>
                <span className="cds--visually-hidden">Actions</span>
              </TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {group.members.length === 0 && (
              <TableRow>
                <TableCell colSpan={3}>This group has no members.</TableCell>
              </TableRow>
            )}
            {group.members.map((member) => (
              <TableRow key={member.personId}>
                <TableCell>{member.displayName}</TableCell>
                <TableCell>{member.isLead ? 'Group lead' : 'Member'}</TableCell>
                <TableCell>
                  {!member.isLead && (
                    <Button
                      kind="ghost"
                      size="sm"
                      hasIconOnly
                      renderIcon={TrashCan}
                      iconDescription={`Remove ${member.displayName}`}
                      tooltipPosition="left"
                      disabled={remove.isPending}
                      onClick={() => {
                        remove.reset();
                        remove.mutate(member.personId);
                      }}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Failure
          title="Member not added"
          error={add.error}
          specific={{ working_group_member_exists: 'This person is already a member.' }}
        />
        <div className="wg-add">
          <WorkingGroupPersonCombo
            id={`wg-add-member-${group.id}`}
            titleText="Add a member"
            value={newMember}
            onChange={setNewMember}
          />
          <Button
            renderIcon={Add}
            disabled={!newMember || add.isPending}
            onClick={() => newMember && add.mutate(newMember)}
          >
            Add member
          </Button>
        </div>
        {group.canManage && (
          <>
            <Failure title="Lead not changed" error={lead.error} />
            <div className="wg-add">
              <WorkingGroupPersonCombo
                id={`wg-lead-${group.id}`}
                titleText="Group lead"
                helperText="Pick a member or search for anyone. The new lead becomes a member; the previous lead stays one."
                value={newLead ?? (group.lead ? { id: group.lead.personId, label: group.lead.displayName } : null)}
                onChange={setNewLead}
                suggestions={memberChoices}
              />
              <Button
                kind="tertiary"
                disabled={!newLead || newLead.id === group.lead?.personId || lead.isPending}
                onClick={() => newLead && lead.mutate(newLead)}
              >
                Set group lead
              </Button>
            </div>
          </>
        )}
      </Stack>
    </SettingsSection>
  );
}

type MachineItem = WorkingGroupMachineOption & { disabled: boolean };

/** The machines of the group (a replace-all selection) and its places (added and removed one by one). */
export function MachinesAndPlacesSection({ group }: { group: WorkingGroup }) {
  const invalidate = useInvalidate();
  const notify = useNotify();
  const options = useQuery(workingGroupMachinesOptions);
  const [selected, setSelected] = useState<string[]>(() => group.machines.map((machine) => machine.id));
  const items: MachineItem[] = (options.data?.items ?? []).map((option) => ({
    ...option,
    disabled: option.workingGroupId !== undefined && option.workingGroupId !== group.id,
  }));
  const saveMachines = useMutation({
    mutationFn: () => setWorkingGroupMachines(group.id, { machineIds: selected }),
    onSuccess: async () => {
      await invalidate();
      notify({ kind: 'success', title: 'Machines saved' });
    },
    onError: () => void invalidate(),
  });
  const addPlace = useMutation({
    mutationFn: (name: string) => addWorkingGroupPlace(group.id, { name }),
    onSettled: () => invalidate(),
  });
  const removePlace = useMutation({
    mutationFn: (placeId: string) => removeWorkingGroupPlace(group.id, placeId),
    onSettled: () => invalidate(),
  });
  const { control, handleSubmit, reset } = useForm<{ name: string }>({ defaultValues: { name: '' } });
  return (
    <SettingsSection title="Machines and places">
      <Stack gap={6}>
        <Failure
          title="Machines not saved"
          error={saveMachines.error}
          specific={{
            machine_in_other_working_group:
              'A selected machine already belongs to another working group. Release it there first.',
          }}
        />
        <div className="wg-form">
          <MultiSelect<MachineItem>
            autoAlign
            id={`wg-machines-${group.id}`}
            titleText="Machines"
            label="Choose machines"
            helperText="A machine belongs to one group at a time."
            items={items}
            itemToString={(item) =>
              item
                ? item.disabled && item.workingGroupName
                  ? `${item.name} (${item.workingGroupName})`
                  : item.name
                : ''
            }
            selectedItems={items.filter((item) => selected.includes(item.id))}
            onChange={({ selectedItems }) => setSelected((selectedItems ?? []).map((item) => item.id))}
          />
        </div>
        <div>
          <Button disabled={saveMachines.isPending || options.isPending} onClick={() => saveMachines.mutate()}>
            {saveMachines.isPending ? 'Saving…' : 'Save machines'}
          </Button>
        </div>
        <Failure
          title="Place not changed"
          error={addPlace.error ?? removePlace.error}
          specific={{ working_group_place_exists: 'This group already has a place with this name.' }}
        />
        <Table aria-label="Places" size="md">
          <TableHead>
            <TableRow>
              <TableHeader>Place</TableHeader>
              <TableHeader>
                <span className="cds--visually-hidden">Actions</span>
              </TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {group.places.length === 0 && (
              <TableRow>
                <TableCell colSpan={2}>No places yet.</TableCell>
              </TableRow>
            )}
            {group.places.map((place) => (
              <TableRow key={place.id}>
                <TableCell>{place.name}</TableCell>
                <TableCell>
                  <Button
                    kind="ghost"
                    size="sm"
                    hasIconOnly
                    renderIcon={TrashCan}
                    iconDescription={`Remove ${place.name}`}
                    tooltipPosition="left"
                    disabled={removePlace.isPending}
                    onClick={() => {
                      removePlace.reset();
                      removePlace.mutate(place.id);
                    }}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <form
          className="wg-add"
          onSubmit={(event) =>
            void handleSubmit((values) => {
              addPlace.reset();
              addPlace.mutate(values.name.trim(), { onSuccess: () => reset({ name: '' }) });
            })(event)
          }
        >
          <Controller
            control={control}
            name="name"
            rules={{
              validate: (value) =>
                (value.trim() !== '' && value.trim().length <= 80) || 'Enter a name of up to 80 characters.',
            }}
            render={({ field, fieldState }) => (
              <TextInput
                id={`wg-place-${group.id}`}
                labelText="Add a place"
                helperText="A room or area without a machine, such as the soldering corner."
                invalid={Boolean(fieldState.error)}
                invalidText={fieldState.error?.message}
                {...field}
              />
            )}
          />
          <Button type="submit" renderIcon={Add} disabled={addPlace.isPending}>
            Add place
          </Button>
        </form>
      </Stack>
    </SettingsSection>
  );
}
