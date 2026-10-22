import { InlineNotification, Modal, RadioButton, RadioButtonGroup, Stack, TextInput } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import type { SignageOrientation } from '../../api/generated/models';
import { createSignagePlaylist, createSignageScene } from '../../api/generated/signage/signage';
import { LayoutPicker, type LayoutChoice } from './components';
import { errorMessage } from './helpers';
import { customLayoutsQuery } from './layoutQueries';
import { emptyZones, resolveLayout } from './layouts';
import { signagePaths } from './paths';
import { signageKeys } from './queries';

type SceneFields = { name: string; orientation: SignageOrientation; layout: LayoutChoice };

/** New scenes start dark with an empty widget in every zone; everything else is edited in the scene editor. */
export function NewSceneModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<SceneFields>({
    defaultValues: { name: '', orientation: 'portrait', layout: { layoutId: 'stack3', customLayoutId: null } },
  });
  const orientation = form.watch('orientation');
  const customLayouts = useQuery(customLayoutsQuery()).data?.items ?? [];
  const mutation = useMutation({
    mutationFn: (values: SceneFields) =>
      createSignageScene({
        name: values.name.trim(),
        orientation: values.orientation,
        layoutId: values.layout.layoutId,
        customLayoutId: values.layout.customLayoutId,
        backgroundColor: '#161616',
        backgroundFit: 'cover',
        backgroundDim: 30,
        theme: 'dark',
        zones: emptyZones(resolveLayout(values.layout.layoutId, values.layout.customLayoutId, customLayouts)),
      }),
    onSuccess: async (scene) => {
      await queryClient.invalidateQueries({ queryKey: signageKeys.scenes() });
      onClose();
      navigate(signagePaths.scene(scene.id));
    },
  });
  const submit = form.handleSubmit((values) => mutation.mutate(values));
  return (
    <Modal
      open
      size="md"
      modalHeading="New scene"
      modalLabel="Content"
      primaryButtonText={mutation.isPending ? 'Creating…' : 'Create scene'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!mutation.isPending) onClose();
      }}
      onRequestSubmit={submit}
    >
      <form noValidate onSubmit={submit}>
        <Stack gap={5}>
          <TextInput
            id="scene-name"
            labelText="Name"
            maxLength={100}
            invalid={Boolean(form.formState.errors.name)}
            invalidText="Give the scene a name"
            {...form.register('name', { validate: (value) => value.trim() !== '' })}
          />
          <Controller
            control={form.control}
            name="orientation"
            render={({ field }) => (
              <RadioButtonGroup
                legendText="Orientation"
                name="scene-orientation"
                valueSelected={field.value}
                onChange={(value) => field.onChange(value)}
              >
                <RadioButton id="scene-portrait" value="portrait" labelText="Portrait" />
                <RadioButton id="scene-landscape" value="landscape" labelText="Landscape" />
              </RadioButtonGroup>
            )}
          />
          <Controller
            control={form.control}
            name="layout"
            render={({ field }) => (
              <LayoutPicker
                value={field.value}
                orientation={orientation}
                customLayouts={customLayouts}
                onChange={field.onChange}
              />
            )}
          />
          {mutation.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Scene not created"
              subtitle={errorMessage(mutation.error)}
            />
          )}
        </Stack>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function NewPlaylistModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<{ name: string }>({ defaultValues: { name: '' } });
  const mutation = useMutation({
    mutationFn: (values: { name: string }) => createSignagePlaylist({ name: values.name.trim(), items: [] }),
    onSuccess: async (playlist) => {
      await queryClient.invalidateQueries({ queryKey: signageKeys.playlists() });
      onClose();
      navigate(signagePaths.playlist(playlist.id));
    },
  });
  const submit = form.handleSubmit((values) => mutation.mutate(values));
  return (
    <Modal
      open
      size="xs"
      modalHeading="New playlist"
      modalLabel="Content"
      primaryButtonText={mutation.isPending ? 'Creating…' : 'Create playlist'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!mutation.isPending) onClose();
      }}
      onRequestSubmit={submit}
    >
      <form noValidate onSubmit={submit}>
        <Stack gap={5}>
          <TextInput
            id="playlist-name"
            labelText="Name"
            maxLength={100}
            invalid={Boolean(form.formState.errors.name)}
            invalidText="Give the playlist a name"
            {...form.register('name', { validate: (value) => value.trim() !== '' })}
          />
          {mutation.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Playlist not created"
              subtitle={errorMessage(mutation.error)}
            />
          )}
        </Stack>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
