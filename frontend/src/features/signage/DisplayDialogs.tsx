import { useState } from 'react';
import { InlineNotification, Modal, Stack, TextInput } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { SignageDisplay } from '../../api/generated/models';
import { deleteSignageDisplay } from '../../api/generated/signage/signage';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { errorMessage, isStaleWrite } from './helpers';
import { signagePaths } from './paths';
import { settingsOf, useUpdateDisplay } from './displayMutations';
import { useUpdateGroup } from './groupMutations';
import { ownerInfo, type PlaybackOwner } from './playbackOwner';
import { signageKeys } from './queries';
import { SceneListFields } from './SceneListFields';
import { sceneListDraftOf, sceneListError, type SceneListDraftItem } from './sceneListDraft';

const staleText = 'This display was changed somewhere else. It was refreshed; try again.';

export function RenameDisplayModal({ display, onClose }: { display: SignageDisplay; onClose: () => void }) {
  const [name, setName] = useState(display.name);
  const update = useUpdateDisplay(display.id);
  const invalid = name.trim() === '';
  const save = () => {
    if (!invalid)
      update.mutate(
        { ...settingsOf(display), expectedVersion: display.version, name: name.trim() },
        { onSuccess: onClose },
      );
  };
  return (
    <Modal
      open
      size="xs"
      modalHeading="Rename display"
      modalLabel={display.name}
      primaryButtonText={update.isPending ? 'Saving…' : 'Save'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={update.isPending}
      preventCloseOnClickOutside
      onRequestClose={onClose}
      onRequestSubmit={save}
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <Stack gap={5}>
          <TextInput
            id="display-rename"
            labelText="Name"
            maxLength={100}
            value={name}
            invalid={invalid}
            invalidText="Give the display a name"
            onChange={(event) => setName(event.target.value)}
          />
          {update.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Not renamed"
              subtitle={isStaleWrite(update.error) ? staleText : errorMessage(update.error)}
            />
          )}
        </Stack>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function DefaultScenesModal({ owner, onClose }: { owner: PlaybackOwner; onClose: () => void }) {
  const info = ownerInfo(owner);
  const [scenes, setScenes] = useState<SceneListDraftItem[]>(() => sceneListDraftOf(info.defaultScenes));
  const [showError, setShowError] = useState(false);
  const updateDisplay = useUpdateDisplay(info.id);
  const updateGroup = useUpdateGroup(info.id);
  const update = owner.kind === 'group' ? updateGroup : updateDisplay;
  const error = sceneListError(scenes);
  const save = () => {
    if (error) {
      setShowError(true);
      return;
    }
    const defaultScenes = scenes.map(({ sceneId, seconds, transition }) => ({
      sceneId,
      seconds: seconds >= 3 && seconds <= 3600 ? seconds : 20,
      transition,
    }));
    if (owner.kind === 'group')
      updateGroup.mutate(
        {
          expectedVersion: owner.group.version,
          name: owner.group.name,
          aspectRatio: owner.group.aspectRatio,
          defaultScenes,
        },
        { onSuccess: onClose },
      );
    else
      updateDisplay.mutate(
        { ...settingsOf(owner.display), expectedVersion: owner.display.version, defaultScenes },
        { onSuccess: onClose },
      );
  };
  return (
    <Modal
      open
      size="md"
      modalHeading="Default scenes"
      modalLabel={info.name}
      primaryButtonText={update.isPending ? 'Saving…' : 'Save'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={update.isPending}
      preventCloseOnClickOutside
      onRequestClose={onClose}
      onRequestSubmit={save}
    >
      <Stack gap={5}>
        <p className="sg-secondary">Shown when no rule matches. Changing them needs publishing.</p>
        <SceneListFields
          idPrefix="default"
          label="Show"
          value={scenes}
          onChange={setScenes}
          aspectRatio={info.aspectRatio}
          invalidText={showError && error ? error : undefined}
        />
        {update.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Not saved"
            subtitle={
              isStaleWrite(update.error)
                ? `This ${info.kind} was changed somewhere else. It was refreshed; try again.`
                : errorMessage(update.error)
            }
          />
        )}
      </Stack>
    </Modal>
  );
}

/** Deletes a display in any state and returns to the Displays list. */
export function DeleteDisplayDialog({ display, onClose }: { display: SignageDisplay; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () => deleteSignageDisplay(display.id, { expectedVersion: display.version }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: signageKeys.display(display.id) });
      queryClient.removeQueries({ queryKey: signageKeys.rules(display.id) });
      queryClient.removeQueries({ queryKey: signageKeys.preview(display.id) });
      await queryClient.invalidateQueries({ queryKey: signageKeys.displays() });
      onClose();
      void navigate(signagePaths.displays);
    },
    onError: (error) => {
      if (isStaleWrite(error)) void queryClient.invalidateQueries({ queryKey: signageKeys.displays() });
    },
  });
  return (
    <DestructiveActionDialog
      open
      title="Delete display"
      fate="permanent"
      confirmLabel="Delete"
      pending={remove.isPending}
      error={remove.isError ? (isStaleWrite(remove.error) ? staleText : errorMessage(remove.error)) : undefined}
      onConfirm={() => remove.mutate()}
      onClose={onClose}
    >
      <p>
        {display.name}: The display is disconnected and removed with its rules and publications. The screen shows a new
        pairing code.
      </p>
    </DestructiveActionDialog>
  );
}
