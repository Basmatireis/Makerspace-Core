import {
  InlineNotification,
  MultiSelect,
  NumberInput,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  Toggle,
} from '@carbon/react';
import type { SignageTimelapseWidget, SignageTransition } from '../../api/generated/models';
import { FitField } from './components';
import type { MachineOption } from './preview';
import { clampInt, LIMITS } from './widgets';

type Option = { id: string; label: string };

/** Timelapse widget: which machines' clips, how many and how old, how long each plays and how they change. */
export function TimelapseFields({
  widget,
  machines,
  outsideDisplays,
  onChange,
}: {
  widget: SignageTimelapseWidget;
  machines: readonly MachineOption[];
  outsideDisplays: readonly string[];
  onChange: (widget: SignageTimelapseWidget) => void;
}) {
  const options: Option[] = machines.map((machine) => ({ id: machine.id, label: machine.name }));
  const machineName = (id: string) => machines.find((machine) => machine.id === id)?.name ?? 'Unknown machine';
  const number = (key: 'count' | 'maxAgeDays' | 'maxSeconds', min: number, max: number) => (value: unknown) => {
    const next = clampInt(value, min, max);
    if (next !== null) onChange({ ...widget, [key]: next });
  };
  return (
    <>
      <RadioButtonGroup
        legendText="Clips from"
        name="wf-timelapse-source"
        valueSelected={widget.source}
        onChange={(value) => {
          const source = value as SignageTimelapseWidget['source'];
          onChange({ ...widget, source, machineIds: source === 'all' ? [] : widget.machineIds });
        }}
      >
        <RadioButton id="wf-timelapse-all" value="all" labelText="All machines" />
        <RadioButton id="wf-timelapse-machines" value="machines" labelText="Selected machines" />
      </RadioButtonGroup>
      {widget.source === 'machines' && (
        <MultiSelect<Option>
          id="wf-timelapse-machine-list"
          key={options.map((item) => item.id).join(',')}
          titleText="Machines"
          label="Choose machines"
          helperText={
            machines.length === 0 ? 'No machines are set up yet.' : `At most ${LIMITS.timelapseMachines} machines.`
          }
          items={options}
          itemToString={(item) => item?.label ?? ''}
          initialSelectedItems={widget.machineIds.map((id) => ({ id, label: machineName(id) }))}
          onChange={({ selectedItems }) =>
            onChange({ ...widget, machineIds: (selectedItems ?? []).map((item) => item.id) })
          }
        />
      )}
      <NumberInput
        id="wf-timelapse-count"
        label="Number of clips"
        helperText="The newest clips are shown first."
        min={1}
        max={LIMITS.timelapseCount}
        value={widget.count}
        onChange={(_, { value }) => number('count', 1, LIMITS.timelapseCount)(value)}
      />
      <NumberInput
        id="wf-timelapse-age"
        label="Maximum age in days"
        helperText="Only prints that ended within this many days. 0 shows clips of any age."
        min={0}
        max={LIMITS.timelapseMaxAgeDays}
        value={widget.maxAgeDays}
        onChange={(_, { value }) => number('maxAgeDays', 0, LIMITS.timelapseMaxAgeDays)(value)}
      />
      <NumberInput
        id="wf-timelapse-seconds"
        label="Maximum seconds per clip"
        helperText="A shorter clip plays to its end; a longer one is cut off after this time."
        min={LIMITS.timelapseMinSeconds}
        max={LIMITS.timelapseMaxSeconds}
        value={widget.maxSeconds}
        onChange={(_, { value }) => number('maxSeconds', LIMITS.timelapseMinSeconds, LIMITS.timelapseMaxSeconds)(value)}
      />
      <Select
        id="wf-timelapse-transition"
        labelText="Transition"
        value={widget.transition}
        onChange={(event) => onChange({ ...widget, transition: event.target.value as SignageTransition })}
      >
        <SelectItem value="cut" text="Cut" />
        <SelectItem value="fade" text="Fade" />
      </Select>
      <Toggle
        id="wf-timelapse-caption"
        size="sm"
        labelText="Caption with machine and day"
        labelA="Off"
        labelB="On"
        toggled={widget.showCaption}
        onToggle={(showCaption) => onChange({ ...widget, showCaption })}
      />
      <FitField id="wf-timelapse-fit" value={widget.fit} onChange={(fit) => onChange({ ...widget, fit })} />
      <p className="sg-secondary">
        Timelapses of finished prints play muted, newest first. A run hidden from signage never appears. Clips show on
        published displays and in the display preview; this editor preview stays empty.
      </p>
      {outsideDisplays.length > 0 && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Timelapses not shown on outside displays"
          subtitle={`On ${outsideDisplays.join(', ')} this widget stays empty, because live cameras and timelapses are not allowed there.`}
        />
      )}
    </>
  );
}
