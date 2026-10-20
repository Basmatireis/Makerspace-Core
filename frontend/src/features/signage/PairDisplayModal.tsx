import { Modal, RadioButton, RadioButtonGroup, Select, SelectItem, Stack, TextInput, Toggle, InlineNotification } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import type { SignageOrientation } from '../../api/generated/models';
import { pairSignageDisplay } from '../../api/generated/signage/signage';
import { ApiError } from '../../api/http-client';
import { PlayerAddress } from './components';
import { errorMessage, resolutionLabel, resolutionOptions } from './helpers';
import { signagePaths } from './paths';
import { playlistsQuery, signageKeys } from './queries';

/** Characters the player's pairing codes are made of (no I, O, 0 or 1). */
const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const normalizeCode = (value: string) => value.replace(/\s+/g, '').toUpperCase().slice(0, 6);
const CODE_REJECTED = 'This code was not accepted. Check the code on the screen; codes expire after 15 minutes. After several wrong attempts, wait a few minutes.';

type Values = { code: string; name: string; location: string; orientation: SignageOrientation; resolution: string; visibleFromOutside: boolean; defaultPlaylistId: string };

/** Pairs a screen by the code its player shows. An unknown, expired or rate-limited code all read the same. */
export function PairDisplayModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const playlists = useQuery(playlistsQuery());
  const form = useForm<Values>({ defaultValues: { code: '', name: '', location: '', orientation: 'landscape', resolution: '0', visibleFromOutside: false, defaultPlaylistId: '' } });
  const { errors } = form.formState;
  const orientation = form.watch('orientation');
  const items = playlists.data?.items ?? [];

  const mutation = useMutation({
    mutationFn: (values: Values) => {
      const resolution = resolutionOptions(values.orientation)[Number(values.resolution)];
      return pairSignageDisplay({
        code: normalizeCode(values.code), name: values.name.trim(), location: values.location.trim(), orientation: values.orientation, resolution,
        visibleFromOutside: values.visibleFromOutside, defaultPlaylistId: values.defaultPlaylistId,
      });
    },
    onSuccess: async (display) => {
      await queryClient.invalidateQueries({ queryKey: signageKeys.displays() });
      navigate(signagePaths.display(display.id));
    },
    onError: (error) => {
      if (error instanceof ApiError && ((error.status === 422 && (error.data as { code?: string } | undefined)?.code === 'pairing_code_invalid') || error.status === 429)) {
        form.setError('code', { type: 'server', message: CODE_REJECTED });
      }
    },
  });
  const codeRejected = mutation.isError && Boolean(errors.code?.type === 'server');
  const submit = form.handleSubmit((values) => mutation.mutate(values));

  return (
    <Modal
      open size="md" modalHeading="Pair display" modalLabel="Displays" primaryButtonText={mutation.isPending ? 'Pairing…' : 'Pair display'} secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending || items.length === 0} preventCloseOnClickOutside onRequestClose={() => { if (!mutation.isPending) onClose(); }}
      onRequestSubmit={submit}
    >
      <form noValidate onSubmit={submit}>
      <Stack gap={5}>
        <p>On the screen, open <PlayerAddress /> in the kiosk browser; it shows a 6-character code.</p>
        <Controller control={form.control} name="code" rules={{ validate: (value) => CODE_PATTERN.test(normalizeCode(value)) || 'Enter the 6 characters shown on the screen' }} render={({ field }) => (
          <TextInput
            id="pair-code" labelText="Pairing code" placeholder="e.g. K7F2QX" autoComplete="off" autoCapitalize="characters" spellCheck={false}
            helperText="Shown on the screen once the player is started. Letters A–Z (without I and O) and digits 2–9; case does not matter."
            value={field.value} invalid={Boolean(errors.code)} invalidText={errors.code?.message}
            onChange={(event) => { field.onChange(normalizeCode(event.target.value)); if (errors.code?.type === 'server') form.clearErrors('code'); }} onBlur={field.onBlur}
          />
        )} />
        <TextInput id="pair-name" labelText="Name" placeholder="e.g. Entrance window" maxLength={100} invalid={Boolean(errors.name)} invalidText="Give the display a name" {...form.register('name', { validate: (value) => value.trim() !== '' })} />
        <TextInput id="pair-location" labelText="Location (optional)" placeholder="e.g. Ground floor" maxLength={150} {...form.register('location')} />
        <Controller control={form.control} name="orientation" render={({ field }) => (
          <RadioButtonGroup legendText="Orientation" name="pair-orientation" valueSelected={field.value} onChange={(value) => { field.onChange(value); form.setValue('resolution', '0'); }}>
            <RadioButton id="pair-portrait" value="portrait" labelText="Portrait" />
            <RadioButton id="pair-landscape" value="landscape" labelText="Landscape" />
          </RadioButtonGroup>
        )} />
        <Select id="pair-resolution" labelText="Resolution" {...form.register('resolution')}>
          {resolutionOptions(orientation).map((item, index) => <SelectItem key={resolutionLabel(item)} value={String(index)} text={resolutionLabel(item)} />)}
        </Select>
        <Controller control={form.control} name="visibleFromOutside" render={({ field }) => (
          <Toggle id="pair-outside" labelText="Visible from outside" labelA="No" labelB="Yes" toggled={field.value} onToggle={field.onChange} />
        )} />
        <p className="sg-secondary">Camera zones then need confirmation; no customer data is ever shown.</p>
        <Select id="pair-playlist" labelText="Default playlist" helperText="Plays when no rule matches." invalid={Boolean(errors.defaultPlaylistId)} invalidText="Choose a default playlist" disabled={playlists.isPending}
          {...form.register('defaultPlaylistId', { validate: (value) => value !== '' })}>
          <SelectItem value="" text="Choose a playlist…" />
          {items.map((playlist) => <SelectItem key={playlist.id} value={playlist.id} text={playlist.name} />)}
        </Select>
        {playlists.isSuccess && items.length === 0 && <InlineNotification kind="info" lowContrast hideCloseButton title="No playlists yet" subtitle="A display needs a default playlist. Create one under Content first." />}
        {mutation.isError && !codeRejected && <InlineNotification kind="error" lowContrast hideCloseButton title="Display not paired" subtitle={errorMessage(mutation.error)} />}
      </Stack>
      <button type="submit" hidden />
      </form>
    </Modal>
  );
}
