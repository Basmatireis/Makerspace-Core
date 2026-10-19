import { useState } from 'react';
import { Modal, RadioButton, RadioButtonGroup, Select, SelectItem, Stack, TextInput, Toggle } from '@carbon/react';
import { useSimulatedMutation, useStore } from '../../store';
import { useSignage, type PairResult } from '../SignageContext';
import { RESOLUTIONS } from '../mockData';
import type { Orientation } from '../types';

/** Staff enter the six-character code that an unpaired player shows. Only K7F2QX is waiting in this prototype. */
export function PairDisplayModal({ onClose }: { onClose: () => void }) {
  const signage = useSignage();
  const store = useStore();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [orientation, setOrientation] = useState<Orientation>('portrait');
  const [resolution, setResolution] = useState('0');
  const [outside, setOutside] = useState(false);
  const [playlistId, setPlaylistId] = useState(signage.playlists[0]?.id ?? '');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const codeValid = code.length === 6;
  const valid = codeValid && name.trim() !== '' && playlistId !== '';
  const { mutate, pending } = useSimulatedMutation((): PairResult => signage.pairDisplay({
    code, name, location, orientation, resolution: RESOLUTIONS[orientation][Number(resolution)], outside, defaultPlaylistId: playlistId,
  }));

  const submit = async () => {
    setTouched(true);
    if (!valid) return;
    const result = await mutate();
    if (!result.ok) { setCodeError(result.error); return; }
    store.notify({ kind: 'success', title: 'Display paired', subtitle: `${result.display.name} is ready.`, action: { label: 'Open display', to: `/signage/displays/${result.display.id}` } });
    onClose();
  };

  return (
    <Modal open size="md" modalHeading="Pair display" modalLabel="Digital signage" primaryButtonText={pending ? 'Pairing…' : 'Pair display'} secondaryButtonText="Cancel" primaryButtonDisabled={pending}
      preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}>
      <Stack gap={5}>
        <TextInput id="pair-code" labelText="Pairing code" helperText="Shown on the screen" maxLength={6} autoComplete="off" value={code} disabled={pending}
          invalid={Boolean(codeError) || (touched && !codeValid)} invalidText={codeError ?? 'Enter the six characters shown on the screen'}
          onChange={(event) => { setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')); setCodeError(null); }} />
        <TextInput id="pair-name" labelText="Name" value={name} disabled={pending} invalid={touched && name.trim() === ''} invalidText="Give the display a name" onChange={(event) => setName(event.target.value)} />
        <TextInput id="pair-location" labelText="Location (optional)" value={location} disabled={pending} onChange={(event) => setLocation(event.target.value)} />
        <RadioButtonGroup legendText="Orientation" name="pair-orientation" valueSelected={orientation} onChange={(value) => { setOrientation(value as Orientation); setResolution('0'); }}>
          <RadioButton id="pair-portrait" value="portrait" labelText="Portrait" />
          <RadioButton id="pair-landscape" value="landscape" labelText="Landscape" />
        </RadioButtonGroup>
        <Select id="pair-resolution" labelText="Resolution" value={resolution} disabled={pending} onChange={(event) => setResolution(event.target.value)}>
          {RESOLUTIONS[orientation].map((item, index) => <SelectItem key={`${item.w}x${item.h}`} value={String(index)} text={`${item.w} × ${item.h}`} />)}
        </Select>
        <Toggle id="pair-outside" labelText="Visible from outside" labelA="No" labelB="Yes" toggled={outside} onToggle={setOutside} disabled={pending} />
        <p className="mj-secondary">Camera zones then need confirmation; no customer data is ever shown.</p>
        <Select id="pair-playlist" labelText="Default playlist" helperText="Shown when no rule matches." value={playlistId} disabled={pending} onChange={(event) => setPlaylistId(event.target.value)}>
          {signage.playlists.map((playlist) => <SelectItem key={playlist.id} value={playlist.id} text={playlist.name} />)}
        </Select>
      </Stack>
    </Modal>
  );
}
