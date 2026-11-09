import { InlineNotification, Modal, Stack, TextInput } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { createSignageScene } from '../../api/generated/signage/signage';
import { aspectFieldsOf, aspectOfFields, type AspectFields } from './aspectFields';
import { AspectRatioFields } from './AspectRatioFields';
import { LayoutPicker, type LayoutChoice } from './components';
import { ASPECT_PRESETS, errorMessage, orientationOf } from './helpers';
import { customLayoutsQuery } from './layoutQueries';
import { emptyZones, resolveLayout } from './layouts';
import { signagePaths } from './paths';
import { signageKeys } from './queries';

type SceneFields = AspectFields & { name: string; layout: LayoutChoice };

/** New scenes start dark with an empty widget in every zone; everything else is edited in the scene editor. */
export function NewSceneModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<SceneFields>({
    defaultValues: {
      name: '',
      ...aspectFieldsOf(ASPECT_PRESETS[1].ratio),
      layout: { layoutId: 'stack3', customLayoutId: null },
    },
  });
  const [aspectPreset, aspectCustom] = form.watch(['aspectPreset', 'aspectCustom']);
  const orientation = orientationOf(aspectOfFields({ aspectPreset, aspectCustom }));
  const customLayouts = useQuery(customLayoutsQuery()).data?.items ?? [];
  const mutation = useMutation({
    mutationFn: (values: SceneFields) =>
      createSignageScene({
        name: values.name.trim(),
        aspectRatio: aspectOfFields(values),
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
      void navigate(signagePaths.scene(scene.id));
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
      onRequestSubmit={() => void submit()}
    >
      <form noValidate onSubmit={(event) => void submit(event)}>
        <Stack gap={5}>
          <TextInput
            id="scene-name"
            labelText="Name"
            maxLength={100}
            invalid={Boolean(form.formState.errors.name)}
            invalidText="Give the scene a name"
            {...form.register('name', { validate: (value) => value.trim() !== '' })}
          />
          <AspectRatioFields form={form} idPrefix="scene" />
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
