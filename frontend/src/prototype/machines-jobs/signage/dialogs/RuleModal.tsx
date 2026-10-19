import { useMemo, useState } from 'react';
import { Checkbox, CheckboxGroup, ComboBox, Modal, MultiSelect, NumberInput, RadioButton, RadioButtonGroup, Select, SelectItem, Stack, TextInput } from '@carbon/react';
import { MACHINE_KEYS, MACHINE_NAMES } from '../engine';
import { useSignage } from '../SignageContext';
import type { Condition, Display, MachineKey, MultiMode, Rule, Target } from '../types';

const WEEKDAYS = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6], ['Sun', 7]] as const;
type Option = { id: string; label: string; target: Target };
type MachineOption = { id: MachineKey; label: string };

const hasCamera = (zones: Record<string, { type: string }>) => Object.values(zones).some((widget) => widget.type === 'camera');

/** Adds a rule ("When … show …") or edits one. Rules are drafts until the display is published. */
export function RuleModal({ display, rule, onClose }: { display: Display; rule?: Rule; onClose: () => void }) {
  const signage = useSignage();
  const [kind, setKind] = useState<Condition['kind']>(rule?.condition.kind ?? 'time');
  const timeInit = rule?.condition.kind === 'time' ? rule.condition : null;
  const machineInit = rule?.condition.kind === 'machines' ? rule.condition : null;
  const [days, setDays] = useState<number[]>(timeInit?.days ?? [1, 2, 3, 4, 5]);
  const [from, setFrom] = useState(timeInit?.from ?? '08:00');
  const [to, setTo] = useState(timeInit?.to ?? '10:00');
  const [machines, setMachines] = useState<MachineKey[]>(machineInit?.machines ?? ['h2d']);
  const [mode, setMode] = useState<'any' | 'all'>(machineInit?.mode ?? 'any');
  const [target, setTarget] = useState<Target | null>(rule?.target ?? null);
  const [multi, setMulti] = useState<MultiMode>(rule?.multiMode ?? 'split');
  const [alternate, setAlternate] = useState(rule?.alternateSeconds ?? 10);
  const [minSeconds, setMinSeconds] = useState(rule?.minSeconds ?? 20);
  const [touched, setTouched] = useState(false);

  const options: Option[] = useMemo(() => [
    ...signage.scenes.map((scene) => ({ id: `scene:${scene.id}`, label: `Scene ${scene.name}`, target: { type: 'scene' as const, id: scene.id } })),
    ...signage.playlists.map((playlist) => ({ id: `playlist:${playlist.id}`, label: `Playlist ${playlist.name}`, target: { type: 'playlist' as const, id: playlist.id } })),
  ], [signage.scenes, signage.playlists]);
  const selected = options.find((option) => option.target.type === target?.type && option.target.id === target?.id) ?? null;
  const targetHasCamera = target?.type === 'scene' && hasCamera(signage.scenes.find((scene) => scene.id === target.id)?.zones ?? {});
  const askMulti = targetHasCamera && kind === 'machines' && machines.length > 1;

  const errors = {
    days: kind === 'time' && days.length === 0 ? 'Choose at least one weekday' : null,
    times: kind === 'time' && (from === '' || to === '' || from === to) ? 'Start and end must differ' : null,
    machines: kind === 'machines' && machines.length === 0 ? 'Choose at least one machine' : null,
    target: target === null ? 'Choose what to show' : null,
  };
  const valid = Object.values(errors).every((error) => error === null) && minSeconds >= 1;

  const save = () => {
    setTouched(true);
    if (!valid || !target) return;
    const condition: Condition = kind === 'time' ? { kind, days, from, to } : kind === 'machines' ? { kind, machines, mode } : kind === 'announcement' ? { kind } : { kind };
    const values = { condition, target, minSeconds, multiMode: askMulti ? multi : (rule?.multiMode ?? 'split'), alternateSeconds: alternate };
    if (rule) signage.updateRule(display.id, rule.id, values); else signage.addRule(display.id, values);
    onClose();
  };

  return (
    <Modal open size="md" modalHeading={rule ? 'Edit rule' : 'Add rule'} modalLabel={display.name} primaryButtonText={rule ? 'Save rule' : 'Add rule'} secondaryButtonText="Cancel" preventCloseOnClickOutside onRequestClose={onClose} onRequestSubmit={save}>
      <Stack gap={5}>
        <Select id="rule-kind" labelText="When" value={kind} onChange={(event) => setKind(event.target.value as Condition['kind'])}>
          <SelectItem value="time" text="Time window" />
          <SelectItem value="machines" text="Machine printing" />
          <SelectItem value="announcement" text="Announcement active" />
          <SelectItem value="stale" text="Live data unavailable" />
        </Select>
        {kind === 'time' && (
          <>
            <CheckboxGroup legendText="Weekdays" invalid={touched && Boolean(errors.days)} invalidText={errors.days ?? ''} orientation="horizontal">
              {WEEKDAYS.map(([label, value]) => (
                <Checkbox key={value} id={`rule-day-${value}`} labelText={label} checked={days.includes(value)} onChange={(_, { checked }) => setDays((current) => checked ? [...current, value] : current.filter((item) => item !== value))} />
              ))}
            </CheckboxGroup>
            <div className="sg-form-row">
              <TextInput id="rule-from" type="time" labelText="From" value={from} onChange={(event) => setFrom(event.target.value)} invalid={touched && Boolean(errors.times)} invalidText={errors.times ?? ''} />
              <TextInput id="rule-to" type="time" labelText="To" value={to} onChange={(event) => setTo(event.target.value)} helperText="A later start than end runs over midnight." />
            </div>
          </>
        )}
        {kind === 'machines' && (
          <>
            <MultiSelect<MachineOption>
              id="rule-machines" titleText="Machines" label="Choose machines" items={MACHINE_KEYS.map((key) => ({ id: key, label: MACHINE_NAMES[key] }))} itemToString={(item) => item?.label ?? ''}
              initialSelectedItems={MACHINE_KEYS.filter((key) => machines.includes(key)).map((key) => ({ id: key, label: MACHINE_NAMES[key] }))} invalid={touched && Boolean(errors.machines)} invalidText={errors.machines ?? ''}
              onChange={({ selectedItems }) => setMachines((selectedItems ?? []).map((item) => item.id))} />
            <RadioButtonGroup legendText="Matches when" name="rule-mode" valueSelected={mode} onChange={(value) => setMode(value as 'any' | 'all')}>
              <RadioButton id="rule-mode-any" value="any" labelText="Any of them is printing" />
              <RadioButton id="rule-mode-all" value="all" labelText="All of them are printing" />
            </RadioButtonGroup>
          </>
        )}
        {kind === 'announcement' && <p className="mj-secondary">Matches while an announcement is on. Without such a rule an announcement always comes first; with it, only rules above it can still win.</p>}
        {kind === 'stale' && <p className="mj-secondary">Matches while Core has been unreachable longer than the data may be trusted.</p>}
        <ComboBox<Option>
          id="rule-target" titleText="Show" placeholder="Choose a scene or playlist" items={options} itemToString={(item) => item?.label ?? ''} selectedItem={selected}
          invalid={touched && Boolean(errors.target)} invalidText={errors.target ?? ''} onChange={({ selectedItem }) => setTarget(selectedItem?.target ?? null)} />
        {askMulti && (
          <>
            <RadioButtonGroup legendText="When several machines print" name="rule-multi" valueSelected={multi} onChange={(value) => setMulti(value as MultiMode)}>
              <RadioButton id="rule-multi-split" value="split" labelText="Split screen" />
              <RadioButton id="rule-multi-alt" value="alternate" labelText="Alternate" />
            </RadioButtonGroup>
            {multi === 'alternate' && <NumberInput id="rule-alt" label="Alternate every (seconds)" min={2} max={120} value={alternate} onChange={(_, { value }) => setAlternate(Number(value) || 10)} />}
          </>
        )}
        <NumberInput id="rule-min" label="Minimum display time (seconds)" helperText="Prevents flicker when a printer reconnects" min={1} max={600} value={minSeconds} invalid={minSeconds < 1} invalidText="Enter at least 1 second" onChange={(_, { value }) => setMinSeconds(Number(value) || 0)} />
      </Stack>
    </Modal>
  );
}
