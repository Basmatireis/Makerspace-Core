import { InlineNotification, Modal, RadioButton, RadioButtonGroup, Stack, TextInput } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import type { SignageLayoutId, SignageOrientation } from '../../api/generated/models';
import { createSignagePlaylist, createSignageScene } from '../../api/generated/signage/signage';
import { LayoutPicker } from './components';
import { errorMessage } from './helpers';
import { emptyZones } from './layouts';
import { signagePaths } from './paths';
import { signageKeys } from './queries';

type SceneFields = { name: string; orientation: SignageOrientation; layoutId: SignageLayoutId };

/** New scenes start dark with an empty widget in every zone; everything else is edited in the scene editor. */
export function NewSceneModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<SceneFields>({ defaultValues: { name: '', orientation: 'portrait', layoutId: 'stack3' } });
  const orientation = form.watch('orientation');
  const mutation = useMutation({
    mutationFn: (values: SceneFields) => createSignageScene({
      name: values.name.trim(), orientation: values.orientation, layoutId: values.layoutId, backgroundColor: '#161616', backgroundFit: 'cover', backgroundDim: 30, theme: 'dark', zones: emptyZones(values.layoutId),
    }),
    onSuccess: async (scene) => { await queryClient.invalidateQueries({ queryKey: signageKeys.scenes() }); onClose(); navigate(signagePaths.scene(scene.id)); },
  });
  return (
    <Modal open size="md" modalHeading="New scene" modalLabel="Content" primaryButtonText={mutation.isPending ? 'Creating…' : 'Create scene'} secondaryButtonText="Cancel" primaryButtonDisabled={mutation.isPending}
      preventCloseOnClickOutside onRequestClose={() => { if (!mutation.isPending) onClose(); }} onRequestSubmit={form.handleSubmit((values) => mutation.mutate(values))}>
      <Stack gap={5}>
        <TextInput id="scene-name" labelText="Name" maxLength={100} invalid={Boolean(form.formState.errors.name)} invalidText="Give the scene a name" {...form.register('name', { validate: (value) => value.trim() !== '' })} />
        <Controller control={form.control} name="orientation" render={({ field }) => (
          <RadioButtonGroup legendText="Orientation" name="scene-orientation" valueSelected={field.value} onChange={(value) => field.onChange(value)}>
            <RadioButton id="scene-portrait" value="portrait" labelText="Portrait" />
            <RadioButton id="scene-landscape" value="landscape" labelText="Landscape" />
          </RadioButtonGroup>
        )} />
        <Controller control={form.control} name="layoutId" render={({ field }) => <LayoutPicker value={field.value} orientation={orientation} onChange={field.onChange} />} />
        {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Scene not created" subtitle={errorMessage(mutation.error)} />}
      </Stack>
    </Modal>
  );
}

export function NewPlaylistModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<{ name: string }>({ defaultValues: { name: '' } });
  const mutation = useMutation({
    mutationFn: (values: { name: string }) => createSignagePlaylist({ name: values.name.trim(), items: [] }),
    onSuccess: async (playlist) => { await queryClient.invalidateQueries({ queryKey: signageKeys.playlists() }); onClose(); navigate(signagePaths.playlist(playlist.id)); },
  });
  return (
    <Modal open size="xs" modalHeading="New playlist" modalLabel="Content" primaryButtonText={mutation.isPending ? 'Creating…' : 'Create playlist'} secondaryButtonText="Cancel" primaryButtonDisabled={mutation.isPending}
      preventCloseOnClickOutside onRequestClose={() => { if (!mutation.isPending) onClose(); }} onRequestSubmit={form.handleSubmit((values) => mutation.mutate(values))}>
      <Stack gap={5}>
        <TextInput id="playlist-name" labelText="Name" maxLength={100} invalid={Boolean(form.formState.errors.name)} invalidText="Give the playlist a name" {...form.register('name', { validate: (value) => value.trim() !== '' })} />
        {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Playlist not created" subtitle={errorMessage(mutation.error)} />}
      </Stack>
    </Modal>
  );
}
