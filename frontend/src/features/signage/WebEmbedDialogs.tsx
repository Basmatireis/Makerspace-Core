import { useState } from 'react';
import { Checkbox, InlineNotification, Modal, Stack, TextInput } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
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
import { ASPECT_PRESETS, errorMessage, isStaleWrite } from './helpers';
import { signagePaths } from './paths';
import { signageKeys } from './queries';
import { hostOf, normalizeOrigin } from './webEmbeds';

const staleText = 'This web embed was changed somewhere else. It was refreshed; try again.';

type NewValues = AspectFields & { name: string; website: string };

/** Creates a web embed from a name, an aspect ratio and the first website, then opens it. Content comes afterwards. */
export function NewWebEmbedModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const form = useForm<NewValues>({
    defaultValues: { name: '', website: '', ...aspectFieldsOf(ASPECT_PRESETS[0].ratio) },
  });
  const { errors } = form.formState;
  const mutation = useMutation({
    mutationFn: (values: NewValues) =>
      createSignageWebEmbed({
        name: values.name.trim(),
        aspectRatio: aspectOfFields(values),
        allowedOrigins: [normalizeOrigin(values.website) ?? values.website.trim()],
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
  onConfirm,
  onClose,
}: {
  kind: MediaKind;
  embed: Pick<SignageWebEmbed, 'name' | 'allowedOrigins'>;
  pending: boolean;
  error?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const camera = kind === 'camera';
  return (
    <Modal
      open
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
export function DeleteWebEmbedDialog({ embed, onClose }: { embed: SignageWebEmbed; onClose: () => void }) {
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
