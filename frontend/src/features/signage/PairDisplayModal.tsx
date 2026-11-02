import { Modal, Stack, TextInput, Toggle, InlineNotification } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { pairSignageDisplay } from '../../api/generated/signage/signage';
import { ApiError } from '../../api/http-client';
import { PlayerAddress } from './components';
import { DisplayGroupSelect } from './DisplayGroupSelect';
import { aspectFieldsOf, aspectOfFields, type AspectFields } from './aspectFields';
import { AspectRatioFields } from './AspectRatioFields';
import { errorMessage, ASPECT_PRESETS, aspectLabel, sameRatio } from './helpers';
import { signagePaths } from './paths';
import { groupsQuery, scenesQuery, signageKeys } from './queries';
import { SceneListFields } from './SceneListFields';
import { newSceneListItem, sceneListError, type SceneListDraftItem } from './sceneListDraft';

/** Characters the player's pairing codes are made of (no I, O, 0 or 1). */
const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const normalizeCode = (value: string) => value.replace(/\s+/g, '').toUpperCase().slice(0, 6);
const CODE_REJECTED =
  'This code was not accepted. Check the code on the screen; codes expire after 15 minutes. After several wrong attempts, wait a few minutes.';

type Values = AspectFields & {
  code: string;
  name: string;
  location: string;
  visibleFromOutside: boolean;
  groupId: string;
  defaultScenes: SceneListDraftItem[];
};

/** Pairs a screen by the code its player shows. An unknown, expired or rate-limited code all read the same. */
export function PairDisplayModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const scenes = useQuery(scenesQuery());
  const groups = useQuery(groupsQuery()).data?.items;
  const form = useForm<Values>({
    defaultValues: {
      code: '',
      name: '',
      location: '',
      ...aspectFieldsOf(ASPECT_PRESETS[0].ratio),
      visibleFromOutside: false,
      groupId: '',
      defaultScenes: [newSceneListItem()],
    },
  });
  const { errors } = form.formState;
  const [aspectPreset, aspectCustom] = form.watch(['aspectPreset', 'aspectCustom']);
  const ratio = aspectOfFields({ aspectPreset, aspectCustom });
  const ratioKey = aspectLabel(ratio);
  const groupId = form.watch('groupId');

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

  // A group of another ratio cannot be joined: reset it when the ratio changes.
  useEffect(() => {
    const chosen = form.getValues('groupId');
    if (!chosen || !groups) return;
    const group = groups.find((item) => item.id === chosen);
    if (!group || !sameRatio(group.aspectRatio, ratio)) form.setValue('groupId', '');
    // `ratio` is derived from `ratioKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratioKey, groups, form]);

  const mutation = useMutation({
    mutationFn: (values: Values) =>
      pairSignageDisplay({
        code: normalizeCode(values.code),
        name: values.name.trim(),
        location: values.location.trim(),
        aspectRatio: aspectOfFields(values),
        visibleFromOutside: values.visibleFromOutside,
        ...(values.groupId ? { groupId: values.groupId } : {}),
        defaultScenes: values.groupId
          ? []
          : values.defaultScenes.map(({ sceneId, seconds, transition }) => ({
              sceneId,
              seconds: seconds >= 3 && seconds <= 3600 ? seconds : 20,
              transition,
            })),
      }),
    onSuccess: async (display) => {
      await queryClient.invalidateQueries({ queryKey: signageKeys.displays() });
      navigate(signagePaths.display(display.id));
    },
    onError: (error) => {
      if (
        error instanceof ApiError &&
        ((error.status === 422 && (error.data as { code?: string } | undefined)?.code === 'pairing_code_invalid') ||
          error.status === 429)
      ) {
        form.setError('code', { type: 'server', message: CODE_REJECTED });
      }
    },
  });
  const codeRejected = mutation.isError && Boolean(errors.code?.type === 'server');
  const submit = form.handleSubmit((values) => mutation.mutate(values));

  return (
    <Modal
      open
      size="md"
      modalHeading="Pair display"
      modalLabel="Displays"
      primaryButtonText={mutation.isPending ? 'Pairing…' : 'Pair display'}
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
          <p>
            On the screen, open <PlayerAddress /> in the kiosk browser; it shows a 6-character code.
          </p>
          <Controller
            control={form.control}
            name="code"
            rules={{
              validate: (value) =>
                CODE_PATTERN.test(normalizeCode(value)) || 'Enter the 6 characters shown on the screen',
            }}
            render={({ field }) => (
              <TextInput
                id="pair-code"
                labelText="Pairing code"
                placeholder="e.g. K7F2QX"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                helperText="Shown on the screen once the player is started. Letters A–Z (without I and O) and digits 2–9; case does not matter."
                value={field.value}
                invalid={Boolean(errors.code)}
                invalidText={errors.code?.message}
                onChange={(event) => {
                  field.onChange(normalizeCode(event.target.value));
                  if (errors.code?.type === 'server') form.clearErrors('code');
                }}
                onBlur={field.onBlur}
              />
            )}
          />
          <TextInput
            id="pair-name"
            labelText="Name"
            placeholder="e.g. Entrance window"
            maxLength={100}
            invalid={Boolean(errors.name)}
            invalidText="Give the display a name"
            {...form.register('name', { validate: (value) => value.trim() !== '' })}
          />
          <TextInput
            id="pair-location"
            labelText="Location (optional)"
            placeholder="e.g. Ground floor"
            maxLength={150}
            {...form.register('location')}
          />
          <AspectRatioFields form={form} idPrefix="pair" />
          <Controller
            control={form.control}
            name="visibleFromOutside"
            render={({ field }) => (
              <Toggle
                id="pair-outside"
                labelText="Visible from outside"
                labelA="No"
                labelB="Yes"
                toggled={field.value}
                onToggle={field.onChange}
              />
            )}
          />
          <p className="sg-secondary">Camera zones then need confirmation; no customer data is ever shown.</p>
          <DisplayGroupSelect
            id="pair-group"
            ratio={ratio}
            value={groupId}
            onChange={(value) => form.setValue('groupId', value)}
            helperText="A display in a group plays the group's rules and default scenes."
          />
          {groupId ? (
            <p className="sg-secondary">The group's default scenes and rules apply to this display.</p>
          ) : (
            <>
              <Controller
                control={form.control}
                name="defaultScenes"
                rules={{ validate: (value) => sceneListError(value) ?? true }}
                render={({ field }) => (
                  <SceneListFields
                    idPrefix="pair"
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
                  subtitle="A display needs at least one default scene. Create one under Content first."
                />
              )}
            </>
          )}
          {mutation.isError && !codeRejected && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Display not paired"
              subtitle={errorMessage(mutation.error)}
            />
          )}
        </Stack>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
