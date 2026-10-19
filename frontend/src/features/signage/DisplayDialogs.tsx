import { useState } from 'react';
import { InlineNotification, Modal, Select, SelectItem, Stack, TextInput } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import type { SignageDisplay } from '../../api/generated/models';
import { errorMessage, isStaleWrite } from './helpers';
import { settingsOf, useUpdateDisplay } from './displayMutations';
import { playlistsQuery } from './queries';

const staleText = 'This display was changed somewhere else. It was refreshed; try again.';

export function RenameDisplayModal({ display, onClose }: { display: SignageDisplay; onClose: () => void }) {
  const [name, setName] = useState(display.name);
  const update = useUpdateDisplay(display.id);
  const invalid = name.trim() === '';
  const save = () => { if (!invalid) update.mutate({ ...settingsOf(display), expectedVersion: display.version, name: name.trim() }, { onSuccess: onClose }); };
  return (
    <Modal open size="xs" modalHeading="Rename display" modalLabel={display.name} primaryButtonText={update.isPending ? 'Saving…' : 'Save'} secondaryButtonText="Cancel" primaryButtonDisabled={update.isPending} preventCloseOnClickOutside onRequestClose={onClose} onRequestSubmit={save}>
      <Stack gap={5}>
        <TextInput id="display-rename" labelText="Name" maxLength={100} value={name} invalid={invalid} invalidText="Give the display a name" onChange={(event) => setName(event.target.value)} />
        {update.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Not renamed" subtitle={isStaleWrite(update.error) ? staleText : errorMessage(update.error)} />}
      </Stack>
    </Modal>
  );
}

export function DefaultPlaylistModal({ display, onClose }: { display: SignageDisplay; onClose: () => void }) {
  const playlists = useQuery(playlistsQuery());
  const [playlistId, setPlaylistId] = useState(display.defaultPlaylistId);
  const update = useUpdateDisplay(display.id);
  const save = () => update.mutate({ ...settingsOf(display), expectedVersion: display.version, defaultPlaylistId: playlistId }, { onSuccess: onClose });
  return (
    <Modal open size="xs" modalHeading="Default playlist" modalLabel={display.name} primaryButtonText={update.isPending ? 'Saving…' : 'Save'} secondaryButtonText="Cancel" primaryButtonDisabled={update.isPending} preventCloseOnClickOutside onRequestClose={onClose} onRequestSubmit={save}>
      <Stack gap={5}>
        <Select id="default-playlist" labelText="Plays when no rule matches" helperText="Changing it needs publishing." value={playlistId} onChange={(event) => setPlaylistId(event.target.value)}>
          {(playlists.data?.items ?? []).map((playlist) => <SelectItem key={playlist.id} value={playlist.id} text={playlist.name} />)}
        </Select>
        {update.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={isStaleWrite(update.error) ? staleText : errorMessage(update.error)} />}
      </Stack>
    </Modal>
  );
}
