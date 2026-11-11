import { useEffect, useState, type RefObject } from 'react';
import { Checkbox, InlineNotification, Modal, Stack, TextInput } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import type { SignageWebEmbed } from '../../api/generated/models';
import {
  createSignageWebEmbed,
  deleteSignageWebEmbed,
  rotateSignageWebEmbedKey,
} from '../../api/generated/signage/signage';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { aspectFieldsOf, aspectOfFields, type AspectFields } from './aspectFields';
import { AspectRatioFields } from './AspectRatioFields';
import { DisplayGroupSelect } from './DisplayGroupSelect';
import { ASPECT_PRESETS, aspectLabel, errorMessage, isStaleWrite, sameRatio } from './helpers';
import { signagePaths } from './paths';
import { groupsQuery, scenesQuery, signageKeys } from './queries';
import { SceneListFields } from './SceneListFields';
import { newSceneListItem, sceneListError, type SceneListDraftItem } from './sceneListDraft';
import { hostOf, normalizeOrigin } from './webEmbeds';

const staleText = 'This web embed was changed somewhere else. It was refreshed; try again.';

/** The dialogs unmount when closed, so Carbon cannot return focus: put it back on the launcher once they are gone. */
function useReturnFocus(launcherButtonRef: RefObject<HTMLElement | null> | undefined) {
  useEffect(() => {
    const launcher = launcherButtonRef?.current;
    return () => {
      if (launcher?.isConnected) launcher.focus();
    };
  }, [launcherButtonRef]);
}

type NewValues = AspectFields & {
  name: string;
  website: string;
  groupId: string;
  defaultScenes: SceneListDraftItem[];
};

/**
 * Creates a web embed from a name, an aspect ratio, the first website and its content (a display group or default
 * scenes, as when pairing a display), then opens it. Rules and the data shown come afterwards.
 */
export function NewWebEmbedModal({
  launcherButtonRef,
  onClose,
}: {
  launcherButtonRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  useReturnFocus(launcherButtonRef);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const scenes = useQuery(scenesQuery());
  const groups = useQuery(groupsQuery()).data?.items;
  const form = useForm<NewValues>({
    defaultValues: {
      name: '',
      website: '',
      ...aspectFieldsOf(ASPECT_PRESETS[0].ratio),
      groupId: '',
      defaultScenes: [newSceneListItem()],
    },
  });
  const { errors } = form.formState;
  const [aspectPreset, aspectCustom, groupId] = form.watch(['aspectPreset', 'aspectCustom', 'groupId']);
  const ratio = aspectOfFields({ aspectPreset, aspectCustom });
  const ratioKey = aspectLabel(ratio);

  // Scenes and groups of another ratio cannot be used: drop them when the ratio changes.
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
  useEffect(() => {
    const chosen = form.getValues('groupId');
    if (!chosen || !groups) return;
    const group = groups.find((item) => item.id === chosen);
    if (!group || !sameRatio(group.aspectRatio, ratio)) form.setValue('groupId', '');
    // `ratio` is derived from `ratioKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratioKey, groups, form]);

  const mutation = useMutation({
    mutationFn: (values: NewValues) =>
      createSignageWebEmbed({
        name: values.name.trim(),
        aspectRatio: aspectOfFields(values),
        allowedOrigins: [normalizeOrigin(values.website) ?? values.website.trim()],
        ...(values.groupId
          ? { groupId: values.groupId }
          : {
              defaultScenes: values.defaultScenes.map(({ sceneId, seconds, transition }) => ({
                sceneId,
                seconds: seconds >= 3 && seconds <= 3600 ? seconds : 20,
                transition,
              })),
            }),
      }),
    onSuccess: async (embed) => {
      await queryClient.invalidateQueries({ queryKey: signageKeys.embeds() });
      onClose();
      void navigate(signagePaths.embed(embed.id));
    },
  });
  const submit = form.handleSubmit((values) => mutation.mutate(values));
  return (
    <Modal
      open
      launcherButtonRef={launcherButtonRef}
      size="md"
      modalHeading="New web embed"
      modalLabel="Web embeds"
      primaryButtonText={mutation.isPending ? 'Creating…' : 'Create'}
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
            id="embed-name"
            labelText="Name"
            placeholder="e.g. Open days on the faculty site"
            maxLength={100}
            invalid={Boolean(errors.name)}
            invalidText="Give the web embed a name"
            {...form.register('name', { validate: (value) => value.trim() !== '' })}
          />
          <AspectRatioFields form={form} idPrefix="embed" />
          <TextInput
            id="embed-website"
            labelText="Website"
            placeholder="https://"
            autoComplete="off"
            spellCheck={false}
            helperText="The website that will show it, for example https://fachschaft-muster.example. You can add more later."
            invalid={Boolean(errors.website)}
            invalidText="Enter the website's https address without a path."
            {...form.register('website', { validate: (value) => normalizeOrigin(value) !== null })}
          />
          <DisplayGroupSelect
            id="embed-group"
            ratio={ratio}
            value={groupId}
            onChange={(value) => form.setValue('groupId', value)}
            helperText="An embed in a group plays the group's rules and default scenes."
          />
          {groupId ? (
            <p className="sg-secondary">The group's default scenes and rules apply to this embed.</p>
          ) : (
            <>
              <Controller
                control={form.control}
                name="defaultScenes"
                rules={{ validate: (value) => sceneListError(value) ?? true }}
                render={({ field }) => (
                  <SceneListFields
                    idPrefix="embed"
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
                  subtitle="A web embed needs at least one default scene or a group. Create a scene under Content first."
                />
              )}
            </>
          )}
          <p className="sg-secondary">
            New embeds show public information only. Cameras and timelapses can be switched on afterwards.
          </p>
          {mutation.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Not created"
              subtitle={errorMessage(mutation.error)}
            />
          )}
        </Stack>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export type MediaKind = 'camera' | 'timelapse';

/**
 * Confirmation before cameras or timelapses are shown on other websites: the person must tick that the room is fine
 * with it. Switching them off needs no such step.
 */
export function MediaConfirmModal({
  kind,
  embed,
  pending,
  error,
  launcherButtonRef,
  onConfirm,
  onClose,
}: {
  kind: MediaKind;
  embed: Pick<SignageWebEmbed, 'name' | 'allowedOrigins'>;
  pending: boolean;
  error?: string;
  launcherButtonRef?: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  useReturnFocus(launcherButtonRef);
  const camera = kind === 'camera';
  return (
    <Modal
      open
      launcherButtonRef={launcherButtonRef}
      size="sm"
      modalLabel={embed.name}
      modalHeading={camera ? 'Show printer cameras on other websites?' : 'Show timelapses on other websites?'}
      primaryButtonText={pending ? 'Saving…' : camera ? 'Allow cameras' : 'Allow timelapses'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!acknowledged || pending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!pending) onClose();
      }}
      onRequestSubmit={() => {
        if (acknowledged && !pending) onConfirm();
      }}
    >
      <Stack gap={5}>
        <p>
          Anyone who opens{' '}
          {embed.allowedOrigins.length > 0
            ? embed.allowedOrigins.map((origin) => hostOf(origin)).join(', ')
            : 'any website'}{' '}
          will see {camera ? 'live video from the printers you choose' : 'recordings of finished prints'}. People in the
          room may be visible.
        </p>
        <Checkbox
          id={`embed-confirm-${kind}`}
          labelText="The cameras point at the print beds, and the sign at the door says that pictures may be shown online."
          checked={acknowledged}
          onChange={(_, { checked }) => setAcknowledged(checked)}
        />
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={error} />}
      </Stack>
    </Modal>
  );
}

/** Danger confirmation for a new embed key; the old embed code stops working at once. */
export function RotateKeyDialog({ embed, onClose }: { embed: SignageWebEmbed; onClose: () => void }) {
  const queryClient = useQueryClient();
  const rotate = useMutation({
    mutationFn: () => rotateSignageWebEmbedKey(embed.id, { expectedVersion: embed.version }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(signageKeys.embed(embed.id), updated);
      await queryClient.invalidateQueries({ queryKey: signageKeys.embeds() });
      onClose();
    },
    onError: (error) => {
      if (isStaleWrite(error)) void queryClient.invalidateQueries({ queryKey: signageKeys.embed(embed.id) });
    },
  });
  return (
    <DestructiveActionDialog
      open
      title="Make a new link?"
      fate="none"
      confirmLabel="Make a new link"
      pending={rotate.isPending}
      error={rotate.isError ? (isStaleWrite(rotate.error) ? staleText : errorMessage(rotate.error)) : undefined}
      onConfirm={() => rotate.mutate()}
      onClose={onClose}
    >
      <p>
        The current code stops working at once on every website. Send the new code to whoever runs{' '}
        {embed.allowedOrigins.length > 0
          ? embed.allowedOrigins.map((origin) => hostOf(origin)).join(', ')
          : 'the websites'}
        .
      </p>
    </DestructiveActionDialog>
  );
}

/** Deletes a web embed with its rules and publications and returns to the list. */
export function DeleteWebEmbedDialog({
  embed,
  launcherButtonRef,
  onClose,
}: {
  embed: SignageWebEmbed;
  launcherButtonRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () => deleteSignageWebEmbed(embed.id, { expectedVersion: embed.version }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: signageKeys.embed(embed.id) });
      queryClient.removeQueries({ queryKey: signageKeys.rules(embed.id) });
      queryClient.removeQueries({ queryKey: signageKeys.preview(embed.id) });
      await queryClient.invalidateQueries({ queryKey: signageKeys.embeds() });
      onClose();
      void navigate(signagePaths.embeds);
    },
    onError: (error) => {
      if (isStaleWrite(error)) void queryClient.invalidateQueries({ queryKey: signageKeys.embed(embed.id) });
    },
  });
  return (
    <DestructiveActionDialog
      open
      title="Delete web embed"
      fate="permanent"
      confirmLabel="Delete"
      pending={remove.isPending}
      error={remove.isError ? (isStaleWrite(remove.error) ? staleText : errorMessage(remove.error)) : undefined}
      launcherButtonRef={launcherButtonRef}
      onConfirm={() => remove.mutate()}
      onClose={onClose}
    >
      <p>
        {embed.name}: The embed is removed with its rules and publications. Websites that still show it display “This
        screen isn’t available”.
      </p>
    </DestructiveActionDialog>
  );
}
