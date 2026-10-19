import { useState } from 'react';
import { Modal, RadioButton, RadioButtonGroup, Stack, TextInput } from '@carbon/react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { TemplatePicker } from '../components/TemplatePicker';
import { useSignage } from '../SignageContext';
import type { Orientation } from '../types';

export function NewSceneModal({ onClose }: { onClose: () => void }) {
  const signage = useSignage();
  const store = useStore();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [orientation, setOrientation] = useState<Orientation>('portrait');
  const [templateId, setTemplateId] = useState('stack3');
  const [touched, setTouched] = useState(false);
  const submit = () => {
    setTouched(true);
    if (name.trim() === '') return;
    const scene = signage.createScene({ name, orientation, templateId });
    store.notify({ kind: 'success', title: 'Scene created', subtitle: `${scene.name} is a draft until a display using it is published.` });
    onClose();
    navigate(`/signage/scenes/${scene.id}`);
  };
  return (
    <Modal open size="md" modalHeading="New scene" modalLabel="Content" primaryButtonText="Create scene" secondaryButtonText="Cancel" preventCloseOnClickOutside onRequestClose={onClose} onRequestSubmit={submit}>
      <Stack gap={5}>
        <TextInput id="scene-name" labelText="Name" value={name} invalid={touched && name.trim() === ''} invalidText="Give the scene a name" onChange={(event) => setName(event.target.value)} />
        <RadioButtonGroup legendText="Orientation" name="scene-orientation" valueSelected={orientation} onChange={(value) => setOrientation(value as Orientation)}>
          <RadioButton id="scene-portrait" value="portrait" labelText="Portrait" />
          <RadioButton id="scene-landscape" value="landscape" labelText="Landscape" />
        </RadioButtonGroup>
        <TemplatePicker value={templateId} orientation={orientation} onChange={setTemplateId} />
      </Stack>
    </Modal>
  );
}

export function NewPlaylistModal({ onClose }: { onClose: () => void }) {
  const signage = useSignage();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const submit = () => {
    setTouched(true);
    if (name.trim() === '') return;
    const playlist = signage.createPlaylist(name);
    onClose();
    navigate(`/signage/playlists/${playlist.id}`);
  };
  return (
    <Modal open size="xs" modalHeading="New playlist" modalLabel="Content" primaryButtonText="Create playlist" secondaryButtonText="Cancel" preventCloseOnClickOutside onRequestClose={onClose} onRequestSubmit={submit}>
      <TextInput id="playlist-name" labelText="Name" value={name} invalid={touched && name.trim() === ''} invalidText="Give the playlist a name" onChange={(event) => setName(event.target.value)} />
    </Modal>
  );
}
