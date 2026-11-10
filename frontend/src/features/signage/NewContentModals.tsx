import { InlineNotification, Modal, RadioTile, Stack, TextInput, TileGroup } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { createSignageScene } from '../../api/generated/signage/signage';
import { ratioOfParts, ratioPartsError, type RatioParts } from './aspectFields';
import { AspectRatioInput } from './AspectRatioInput';
import { errorMessage } from './helpers';
import { signagePaths } from './paths';
import { signageKeys } from './queries';
import { starterBlocks, starterZones, STARTERS } from './sceneStarters';

type SceneFields = { name: string; ratio: RatioParts; starter: string };

/** Miniature of a starter in the typed shape: landscape fills the tile width, portrait a fixed height. */
function StarterMiniature({
  zones,
  ratio,
}: {
  zones: ReturnType<typeof starterZones>;
  ratio: { width: number; height: number };
}) {
  return (
    <span
      className={`sg-starter__mini ${ratio.width >= ratio.height ? 'sg-starter__mini--wide' : 'sg-starter__mini--tall'}`}
      style={{ aspectRatio: `${ratio.width} / ${ratio.height}` }}
      aria-hidden="true"
    >
      {zones.map(([x, y, w, h], index) => (
        <i
          key={index}
          style={{
            insetInlineStart: `${4 + x * 92}%`,
            insetBlockStart: `${6 + y * 88}%`,
            inlineSize: `${w * 92}%`,
            blockSize: `${h * 88}%`,
          }}
        />
      ))}
    </span>
  );
}

/** New screens start dark with empty blocks laid out like the chosen starter; everything else is edited in the screen editor. */
export function NewSceneModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<SceneFields>({
    defaultValues: { name: 'Untitled screen', ratio: { width: '16', height: '9' }, starter: 'hmf' },
  });
  const parts = form.watch('ratio');
  const ratioValid = ratioPartsError(parts.width, parts.height) === null;
  const previewRatio = ratioValid ? ratioOfParts(parts) : { width: 16, height: 9 };
  const mutation = useMutation({
    mutationFn: (values: SceneFields) => {
      const aspectRatio = ratioOfParts(values.ratio);
      const starter = STARTERS.find((item) => item.id === values.starter) ?? STARTERS[0];
      return createSignageScene({
        name: values.name.trim(),
        aspectRatio,
        backgroundColor: '#0e1726',
        backgroundFit: 'cover',
        backgroundDim: 0,
        theme: 'dark',
        fontFamily: 'sans',
        blocks: starterBlocks(starter, aspectRatio),
      });
    },
    onSuccess: async (scene) => {
      await queryClient.invalidateQueries({ queryKey: signageKeys.scenes() });
      onClose();
      void navigate(signagePaths.scene(scene.id));
    },
  });
  const submit = form.handleSubmit((values) => {
    if (ratioPartsError(values.ratio.width, values.ratio.height) === null) mutation.mutate(values);
  });
  return (
    <Modal
      open
      size="md"
      modalHeading="New screen"
      modalLabel="Screens"
      primaryButtonText={mutation.isPending ? 'Creating…' : 'Create screen'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending || !ratioValid}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!mutation.isPending) onClose();
      }}
      onRequestSubmit={() => void submit()}
    >
      <form noValidate onSubmit={(event) => void submit(event)}>
        <Stack gap={5}>
          <TextInput
            id="screen-name"
            labelText="Name"
            maxLength={100}
            invalid={Boolean(form.formState.errors.name)}
            invalidText="Give the screen a name"
            {...form.register('name', { validate: (value) => value.trim() !== '' })}
          />
          <Controller
            control={form.control}
            name="ratio"
            render={({ field }) => <AspectRatioInput id="screen-ratio" value={field.value} onChange={field.onChange} />}
          />
          <Controller
            control={form.control}
            name="starter"
            render={({ field }) => (
              <TileGroup<string>
                legend="Start from"
                name="screen-starter"
                valueSelected={field.value}
                onChange={(value) => field.onChange(value)}
                className="sg-starters"
              >
                {STARTERS.map((starter) => (
                  <RadioTile key={starter.id} id={`screen-starter-${starter.id}`} value={starter.id}>
                    <StarterMiniature zones={starterZones(starter, previewRatio)} ratio={previewRatio} />
                    <span className="sg-starter__label">{starter.label}</span>
                  </RadioTile>
                ))}
              </TileGroup>
            )}
          />
          {mutation.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Screen not created"
              subtitle={errorMessage(mutation.error)}
            />
          )}
        </Stack>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
