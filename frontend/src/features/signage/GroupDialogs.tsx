import { useEffect, useState } from 'react';
import { Checkbox, CheckboxGroup, InlineNotification, Modal, Stack, TextInput } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import type { SignageDisplay, SignageDisplayGroup } from '../../api/generated/models';
import { createSignageDisplayGroup, deleteSignageDisplayGroup } from '../../api/generated/signage/signage';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { DeleteDialog } from './components';
import { aspectFieldsOf, aspectOfFields, type AspectFields } from './aspectFields';
import { AspectRatioFields } from './AspectRatioFields';
import { useJoinGroup, useLeaveGroup } from './groupMutations';
import { ASPECT_PRESETS, aspectLabel, errorMessage, isStaleWrite, pluralize, sameRatio } from './helpers';
import { signagePaths } from './paths';
import { scenesQuery, signageKeys } from './queries';
import { SceneListFields } from './SceneListFields';
import { newSceneListItem, sceneListError, type SceneListDraftItem } from './sceneListDraft';

type Values = AspectFields & { name: string; defaultScenes: SceneListDraftItem[] };

/** Creates a group (name, aspect ratio, default scenes) and opens it. */
export function NewGroupModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const scenes = useQuery(scenesQuery());
  const form = useForm<Values>({
    defaultValues: { name: '', ...aspectFieldsOf(ASPECT_PRESETS[0].ratio), defaultScenes: [newSceneListItem()] },
  });
  const { errors } = form.formState;
  const [aspectPreset, aspectCustom] = form.watch(['aspectPreset', 'aspectCustom']);
  const ratio = aspectOfFields({ aspectPreset, aspectCustom });
  const ratioKey = aspectLabel(ratio);

  // Scenes of another ratio cannot be default scenes: drop them when the ratio changes.
  useEffect(() => {
    const all = scenes.data?.items;
    if (!all) return;
    const current = form.getValues('defaultScenes');
    const kept = current.filter((item) => {
      const scene = all.find((entry) => entry.id === item.sceneId);
      return !scene || sameRatio(scene.aspectRatio, ratio);
    });
    if (kept.length !== current.length) form.setValue('defaultScenes', kept.length > 0 ? kept : [newSceneListItem()]);
    // `ratio` is derived from `ratioKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratioKey, scenes.data, form]);

  const mutation = useMutation({
    mutationFn: (values: Values) =>
      createSignageDisplayGroup({
        name: values.name.trim(),
        aspectRatio: aspectOfFields(values),
        defaultScenes: values.defaultScenes.map(({ sceneId, seconds, transition }) => ({
          sceneId,
          seconds: seconds >= 3 && seconds <= 3600 ? seconds : 20,
          transition,
        })),
      }),
    onSuccess: async (group) => {
      await queryClient.invalidateQueries({ queryKey: signageKeys.groups() });
      onClose();
      void navigate(signagePaths.group(group.id));
    },
  });
  const submit = form.handleSubmit((values) => mutation.mutate(values));

  return (
    <Modal
      open
      size="md"
      modalHeading="New group"
      modalLabel="Displays"
      primaryButtonText={mutation.isPending ? 'Creating…' : 'Create group'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!mutation.isPending) onClose();
      }}
      onRequestSubmit={() => void submit()}
    >
      <form noValidate onSubmit={(event) => void submit(event)}>
        <Stack gap={5}>
          <p className="sg-secondary">
            Displays of a group show the same thing: the group owns their rules and default scenes, and publishing the
            group publishes every member.
          </p>
          <TextInput
            id="group-name"
            labelText="Name"
            placeholder="e.g. Hallway screens"
            maxLength={100}
            invalid={Boolean(errors.name)}
            invalidText="Give the group a name"
            {...form.register('name', { validate: (value) => value.trim() !== '' })}
          />
          <AspectRatioFields
            form={form}
            idPrefix="group"
            helperText="Only displays with this aspect ratio can join. It can be changed while the group has no members."
          />
          <Controller
            control={form.control}
            name="defaultScenes"
            rules={{ validate: (value) => sceneListError(value) ?? true }}
            render={({ field }) => (
              <SceneListFields
                idPrefix="group"
                label="Default scenes"
                value={field.value}
                onChange={field.onChange}
                aspectRatio={ratio}
                invalidText={errors.defaultScenes?.message}
              />
            )}
          />
          <p className="sg-secondary">
            Shown when no rule matches. Only scenes of the chosen aspect ratio are offered.
          </p>
          {scenes.isSuccess && scenes.data.items.every((scene) => !sameRatio(scene.aspectRatio, ratio)) && (
            <InlineNotification
              kind="info"
              lowContrast
              hideCloseButton
              title="No scenes for this aspect ratio"
              subtitle="A group needs at least one default scene. Create one under Content first."
            />
          )}
          {mutation.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Group not created"
              subtitle={errorMessage(mutation.error)}
            />
          )}
        </Stack>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Adds standalone displays with the group's aspect ratio. Joining deletes a display's own rules and default list. */
export function AddMembersModal({
  group,
  displays,
  onClose,
}: {
  group: SignageDisplayGroup;
  /** All displays; the ones that can join are picked here. */
  displays: SignageDisplay[];
  onClose: () => void;
}) {
  const join = useJoinGroup(group.id);
  const [chosen, setChosen] = useState<string[]>([]);
  const candidates = displays.filter(
    (display) =>
      display.groupId === null && display.status !== 'revoked' && sameRatio(display.aspectRatio, group.aspectRatio),
  );
  const submit = () => {
    if (chosen.length > 0)
      join.mutate(
        candidates.filter((display) => chosen.includes(display.id)),
        { onSuccess: onClose },
      );
  };
  return (
    <Modal
      open
      size="sm"
      modalHeading="Add displays"
      modalLabel={group.name}
      primaryButtonText={join.isPending ? 'Adding…' : `Add ${pluralize(chosen.length, 'display')}`}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={join.isPending || chosen.length === 0}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!join.isPending) onClose();
      }}
      onRequestSubmit={submit}
    >
      <Stack gap={5}>
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Joining replaces the display’s own playback"
          subtitle="The rules and default scenes of an added display are deleted; it plays the group’s after the next publication."
        />
        {candidates.length === 0 ? (
          <p className="sg-secondary">
            No standalone display with the aspect ratio {aspectLabel(group.aspectRatio)} is available.
          </p>
        ) : (
          <CheckboxGroup legendText={`Standalone displays (${aspectLabel(group.aspectRatio)})`}>
            {candidates.map((display) => (
              <Checkbox
                key={display.id}
                id={`group-add-${display.id}`}
                labelText={display.location ? `${display.name} · ${display.location}` : display.name}
                checked={chosen.includes(display.id)}
                onChange={(_, { checked }) =>
                  setChosen((current) =>
                    checked ? [...current, display.id] : current.filter((item) => item !== display.id),
                  )
                }
              />
            ))}
          </CheckboxGroup>
        )}
        {join.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Not every display was added"
            subtitle={
              isStaleWrite(join.error)
                ? 'A display was changed somewhere else. The lists were refreshed; try again.'
                : errorMessage(join.error)
            }
          />
        )}
      </Stack>
    </Modal>
  );
}

/** Takes a display out of the group; it keeps a copy of the group's rules and default scenes. */
export function RemoveMemberDialog({
  groupId,
  group,
  display,
  onClose,
}: {
  groupId: string;
  group: string;
  display: SignageDisplay;
  onClose: () => void;
}) {
  const leave = useLeaveGroup(groupId);
  return (
    <DestructiveActionDialog
      open
      title="Remove display from group"
      fate="none"
      confirmLabel="Remove"
      pending={leave.isPending}
      error={
        leave.isError
          ? isStaleWrite(leave.error)
            ? 'This display was changed somewhere else. It was refreshed; try again.'
            : errorMessage(leave.error)
          : undefined
      }
      onConfirm={() => leave.mutate(display, { onSuccess: onClose })}
      onClose={onClose}
    >
      <p>
        {display.name} leaves {group} and keeps a copy of the group’s rules and default scenes, so it shows the same as
        before. From then on, changes to the group no longer reach it.
      </p>
    </DestructiveActionDialog>
  );
}

/** Deletes a group without members and returns to the Displays list; a group with members lists them instead. */
export function DeleteGroupDialog({ group, onClose }: { group: SignageDisplayGroup; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (
    <DeleteDialog
      title="Delete group"
      noun="Group"
      confirmLabel="Delete"
      onClose={onClose}
      onDeleted={() => {
        queryClient.removeQueries({ queryKey: signageKeys.group(group.id) });
        queryClient.removeQueries({ queryKey: signageKeys.groupRules(group.id) });
        queryClient.removeQueries({ queryKey: signageKeys.groupPreview(group.id) });
        onClose();
        void navigate(signagePaths.displays);
      }}
      remove={() => deleteSignageDisplayGroup(group.id, { expectedVersion: group.version })}
    >
      <p>{group.name}: The group is removed with its rules and default scenes.</p>
    </DeleteDialog>
  );
}
