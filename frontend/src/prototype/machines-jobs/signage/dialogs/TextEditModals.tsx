import { useState } from 'react';
import { ComboBox, Modal, Stack, TextInput } from '@carbon/react';
import type { Playlist } from '../types';

export function RenameModal({ title, label, initial, onSave, onClose }: { title: string; label: string; initial: string; onSave: (value: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(initial);
  const submit = () => { if (value.trim() === '') return; onSave(value.trim()); onClose(); };
  return (
    <Modal open size="xs" modalHeading={title} primaryButtonText="Save" secondaryButtonText="Cancel" primaryButtonDisabled={value.trim() === ''} preventCloseOnClickOutside onRequestClose={onClose} onRequestSubmit={submit}>
      <Stack gap={5}><TextInput id="rename-input" labelText={label} value={value} data-modal-primary-focus onChange={(event) => setValue(event.target.value)} /></Stack>
    </Modal>
  );
}

export function DefaultPlaylistModal({ playlists, current, onSave, onClose }: { playlists: Playlist[]; current: string; onSave: (id: string) => void; onClose: () => void }) {
  const [selected, setSelected] = useState<Playlist | null>(playlists.find((item) => item.id === current) ?? null);
  return (
    <Modal open size="xs" modalHeading="Default playlist" modalLabel="Otherwise" primaryButtonText="Save" secondaryButtonText="Cancel" primaryButtonDisabled={!selected} preventCloseOnClickOutside onRequestClose={onClose} onRequestSubmit={() => { if (selected) { onSave(selected.id); onClose(); } }}>
      <ComboBox<Playlist> id="default-playlist" titleText="Playlist" helperText="Shown whenever no rule matches." items={playlists} itemToString={(item) => item?.name ?? ''} selectedItem={selected} onChange={({ selectedItem }) => setSelected(selectedItem ?? null)} />
    </Modal>
  );
}
