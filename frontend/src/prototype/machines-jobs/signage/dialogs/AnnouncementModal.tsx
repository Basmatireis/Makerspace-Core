import { useState } from 'react';
import { Modal, RadioButton, RadioButtonGroup, Select, SelectItem, Stack, TextArea, TextInput } from '@carbon/react';
import { useStore } from '../../store';
import { useSignage } from '../SignageContext';
import type { Display } from '../types';

/** Announcement takeover: applies immediately, no publish needed. */
export function AnnouncementModal({ display, onClose }: { display: Display; onClose: () => void }) {
  const signage = useSignage();
  const store = useStore();
  const scenes = signage.scenes.filter((scene) => scene.announcement);
  const [source, setSource] = useState<'scene' | 'text'>('scene');
  const [sceneId, setSceneId] = useState(scenes[0]?.id ?? '');
  const [text, setText] = useState('');
  const [untilMode, setUntilMode] = useState<'stopped' | 'time'>('stopped');
  const [until, setUntil] = useState('');
  const [touched, setTouched] = useState(false);

  const textMissing = source === 'text' && text.trim() === '';
  const untilMissing = untilMode === 'time' && until === '';
  const start = () => {
    setTouched(true);
    if (textMissing || untilMissing || (source === 'scene' && !sceneId)) return;
    let untilIso: string | null = null;
    if (untilMode === 'time') {
      const [hours, minutes] = until.split(':').map(Number);
      const date = new Date();
      date.setHours(hours, minutes, 0, 0);
      if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
      untilIso = date.toISOString();
    }
    signage.startAnnouncement(display.id, { sceneId: source === 'scene' ? sceneId : null, text: source === 'text' ? text.trim() : null, until: untilIso });
    store.notify({ kind: 'success', title: 'Announcement is live', subtitle: `${display.name} switched immediately.` });
    onClose();
  };

  return (
    <Modal open size="sm" modalHeading="Show announcement" modalLabel={display.name} primaryButtonText="Show now" secondaryButtonText="Cancel" preventCloseOnClickOutside onRequestClose={onClose} onRequestSubmit={start}>
      <Stack gap={5}>
        <RadioButtonGroup legendText="Content" name="ann-source" valueSelected={source} onChange={(value) => setSource(value as 'scene' | 'text')}>
          <RadioButton id="ann-scene" value="scene" labelText="Announcement scene" />
          <RadioButton id="ann-text" value="text" labelText="Quick text" />
        </RadioButtonGroup>
        {source === 'scene'
          ? <Select id="ann-scene-select" labelText="Scene" value={sceneId} onChange={(event) => setSceneId(event.target.value)}>{scenes.map((scene) => <SelectItem key={scene.id} value={scene.id} text={scene.name} />)}</Select>
          : <TextArea id="ann-text-input" labelText="Text" rows={3} maxCount={140} enableCounter value={text} invalid={touched && textMissing} invalidText="Enter the text to show" onChange={(event) => setText(event.target.value)} />}
        <RadioButtonGroup legendText="Until" name="ann-until" valueSelected={untilMode} onChange={(value) => setUntilMode(value as 'stopped' | 'time')}>
          <RadioButton id="ann-until-stop" value="stopped" labelText="Until I stop it" />
          <RadioButton id="ann-until-time" value="time" labelText="Until a time" />
        </RadioButtonGroup>
        {untilMode === 'time' && <TextInput id="ann-until-time-input" type="time" labelText="Ends at" value={until} invalid={touched && untilMissing} invalidText="Choose a time" onChange={(event) => setUntil(event.target.value)} />}
        <p className="mj-secondary">The announcement takes over right away; no publishing needed.</p>
      </Stack>
    </Modal>
  );
}
