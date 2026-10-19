import { useState } from 'react';
import { Button, RadioButton, RadioButtonGroup, Select, SelectItem, Stack, StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper, TextInput, Toggle } from '@carbon/react';
import { orientationLabel } from '../helpers';
import { RESOLUTIONS } from '../mockData';
import { useSignage } from '../SignageContext';
import { useSimulatedMutation, useStore } from '../../store';
import type { Display, Orientation } from '../types';

export function DisplaySettingsTab({ display }: { display: Display }) {
  const signage = useSignage();
  const store = useStore();
  const [name, setName] = useState(display.name);
  const [location, setLocation] = useState(display.location);
  const [orientation, setOrientation] = useState<Orientation>(display.orientation);
  const [resolution, setResolution] = useState(() => String(Math.max(0, RESOLUTIONS[display.orientation].findIndex((item) => item.w === display.resolution.w && item.h === display.resolution.h))));
  const [outside, setOutside] = useState(display.outside);
  const [playlistId, setPlaylistId] = useState(display.defaultPlaylistId);
  const { mutate, pending } = useSimulatedMutation(() => {
    signage.updateDisplaySettings(display.id, { name, location, orientation, resolution: RESOLUTIONS[orientation][Number(resolution)], outside });
    signage.setDefaultPlaylist(display.id, playlistId);
  });

  if (!store.can('signage.manage') || display.revoked) {
    return (
      <StructuredListWrapper isCondensed aria-label="Display settings">
        <StructuredListBody>
          <StructuredListRow><StructuredListCell noWrap>Name</StructuredListCell><StructuredListCell>{display.name}</StructuredListCell></StructuredListRow>
          <StructuredListRow><StructuredListCell noWrap>Location</StructuredListCell><StructuredListCell>{display.location || '—'}</StructuredListCell></StructuredListRow>
          <StructuredListRow><StructuredListCell noWrap>Format</StructuredListCell><StructuredListCell>{orientationLabel(display)}</StructuredListCell></StructuredListRow>
          <StructuredListRow><StructuredListCell noWrap>Visible from outside</StructuredListCell><StructuredListCell>{display.outside ? 'Yes' : 'No'}</StructuredListCell></StructuredListRow>
        </StructuredListBody>
      </StructuredListWrapper>
    );
  }

  const save = async () => {
    if (name.trim() === '') return;
    await mutate();
    store.notify({ kind: 'success', title: 'Display settings saved' });
  };
  return (
    <Stack gap={5} className="sg-tab sg-settings">
      <TextInput id="ds-name" labelText="Name" value={name} invalid={name.trim() === ''} invalidText="Give the display a name" onChange={(event) => setName(event.target.value)} />
      <TextInput id="ds-location" labelText="Location" value={location} onChange={(event) => setLocation(event.target.value)} />
      <RadioButtonGroup legendText="Orientation" name="ds-orientation" valueSelected={orientation} onChange={(value) => { setOrientation(value as Orientation); setResolution('0'); }}>
        <RadioButton id="ds-portrait" value="portrait" labelText="Portrait" />
        <RadioButton id="ds-landscape" value="landscape" labelText="Landscape" />
      </RadioButtonGroup>
      <Select id="ds-resolution" labelText="Resolution" value={resolution} onChange={(event) => setResolution(event.target.value)}>
        {RESOLUTIONS[orientation].map((item, index) => <SelectItem key={`${item.w}x${item.h}`} value={String(index)} text={`${item.w} × ${item.h}`} />)}
      </Select>
      <Toggle id="ds-outside" labelText="Visible from outside" labelA="No" labelB="Yes" toggled={outside} onToggle={setOutside} />
      <p className="mj-secondary">Camera zones then need confirmation; no customer data is ever shown.</p>
      <Select id="ds-playlist" labelText="Default playlist" helperText="Changing it needs publishing." value={playlistId} onChange={(event) => setPlaylistId(event.target.value)}>
        {signage.playlists.map((playlist) => <SelectItem key={playlist.id} value={playlist.id} text={playlist.name} />)}
      </Select>
      <div><Button kind="primary" disabled={pending || name.trim() === ''} onClick={() => { void save(); }}>{pending ? 'Saving…' : 'Save settings'}</Button></div>
    </Stack>
  );
}
