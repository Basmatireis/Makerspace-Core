import {
  ContainedList,
  ContainedListItem,
  IconButton,
  InlineNotification,
  Link as CarbonLink,
  MultiSelect,
  NumberInput,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  Slider,
  TextInput,
  Toggle,
} from '@carbon/react';
import { ArrowDown, ArrowUp, TrashCan } from '@carbon/icons-react';
import { Link } from 'react-router-dom';
import type {
  SignageAnnouncementTemplate,
  SignageAsset,
  SignageClockWidget,
  SignageWidget,
} from '../../api/generated/models';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { machineLogbookPaths } from '../machinelogbook/shared/paths';
import { CalendarFields } from './CalendarFields';
import { FitField } from './components';
import { ListFields } from './ListFields';
import type { MachineOption } from './preview';
import { CodeArea, FormatSelect, RichTextAdvanced } from './RichTextFields';
import { MediaPicker } from './MediaPicker';
import { TimelapseFields } from './TimelapseFields';
import { clampInt, formatOf, LIMITS, widgetError, withRichText } from './widgets';

type Option = { id: string; label: string };
/** Shown instead of the camera machine pickers while no machine has a camera; points to the printer connectors when the person may change them. */
function NoCameraNote() {
  const canSetUp = hasPermission(useCurrentUser(), PermissionId.printer_connectorsmanage);
  return (
    <>
      <InlineNotification
        kind="info"
        lowContrast
        hideCloseButton
        title="No machine has a camera yet"
        subtitle={
          canSetUp
            ? 'Switch on "Stream camera" for a Bambu printer assignment under Printer connectors.'
            : 'Cameras are switched on per Bambu printer assignment under Settings, Printer connectors, which needs the printer connectors permission.'
        }
      />
      {canSetUp && (
        <p>
          <CarbonLink as={Link} to={machineLogbookPaths.connectors()}>
            Settings, Printer connectors
          </CarbonLink>
        </p>
      )}
    </>
  );
}

type Props = {
  widget: SignageWidget;
  assets: readonly SignageAsset[];
  templates: readonly SignageAnnouncementTemplate[];
  /** Machines from the signage picker endpoint. */
  machines: readonly MachineOption[];
  /** False while the machine list is still loading (the "no camera" note waits for it). Defaults to true. */
  machinesKnown?: boolean;
  /** Names of displays that show this screen and are visible from outside (camera warning). */
  outsideDisplays?: readonly string[];
  onChange: (widget: SignageWidget) => void;
};

/** The content fields of the selected block's widget. Text size, colours and the box style live in the style sections. */
export function WidgetFields(props: Props) {
  return <TypeFields {...props} />;
}

function TypeFields({
  widget,
  assets,
  templates,
  machines,
  machinesKnown = true,
  outsideDisplays = [],
  onChange,
}: Props) {
  const error = widgetError(widget);
  const fieldError = error ? (
    <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={error} />
  ) : null;
  const machineOptions: Option[] = machines.map((machine) => ({ id: machine.id, label: machine.name }));
  const machineName = (id: string) => machines.find((machine) => machine.id === id)?.name ?? 'Unknown machine';
  const machinesHint = machines.length === 0 ? 'No machines are set up yet.' : undefined;

  switch (widget.type) {
    case 'empty':
      return <p className="sg-secondary">This block is empty. Choose what it shows above.</p>;
    case 'image':
      return (
        <>
          <MediaPicker
            id="wf-image"
            labelText="Image"
            kind="image"
            value={widget.mediaId}
            onChange={(mediaId) => onChange({ ...widget, mediaId })}
          />
          <FitField id="wf-fit" value={widget.fit} onChange={(fit) => onChange({ ...widget, fit })} />
          <Slider
            id="wf-dim"
            labelText="Darken image"
            ariaLabelInput="Darken image"
            min={0}
            max={90}
            step={5}
            formatLabel={(value) => `${value}%`}
            value={widget.dim}
            onChange={({ value }) => {
              if (value !== widget.dim) onChange({ ...widget, dim: value });
            }}
          />
        </>
      );
    case 'video':
      return (
        <>
          <MediaPicker
            id="wf-video"
            labelText="Video"
            kind="video"
            value={widget.mediaId}
            onChange={(mediaId) => onChange({ ...widget, mediaId })}
          />
          <FitField id="wf-fit" value={widget.fit} onChange={(fit) => onChange({ ...widget, fit })} />
          <p className="sg-secondary">Videos always play muted and in a loop.</p>
        </>
      );
    case 'slideshow': {
      const move = (index: number, direction: -1 | 1) => {
        const next = [...widget.mediaIds];
        [next[index], next[index + direction]] = [next[index + direction], next[index]];
        onChange({ ...widget, mediaIds: next });
      };
      return (
        <>
          <ContainedList label="Slides" kind="on-page" isInset>
            {widget.mediaIds.length === 0 && <ContainedListItem>No slides yet</ContainedListItem>}
            {widget.mediaIds.map((mediaId, index) => (
              <ContainedListItem key={`${mediaId}-${index}`}>
                <div className="sg-slide-row">
                  <span className="sg-slide-row__name">
                    {assets.find((item) => item.id === mediaId)?.name ?? 'Removed media'}
                  </span>
                  <IconButton
                    label="Move up"
                    kind="ghost"
                    size="sm"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp />
                  </IconButton>
                  <IconButton
                    label="Move down"
                    kind="ghost"
                    size="sm"
                    disabled={index === widget.mediaIds.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown />
                  </IconButton>
                  <IconButton
                    label="Remove slide"
                    kind="ghost"
                    size="sm"
                    onClick={() => onChange({ ...widget, mediaIds: widget.mediaIds.filter((_, at) => at !== index) })}
                  >
                    <TrashCan />
                  </IconButton>
                </div>
              </ContainedListItem>
            ))}
          </ContainedList>
          <MediaPicker
            id="wf-slide-add"
            labelText="Add slide"
            kind="image"
            value={null}
            onChange={(mediaId) => {
              if (mediaId) onChange({ ...widget, mediaIds: [...widget.mediaIds, mediaId] });
            }}
          />
          <NumberInput
            id="wf-seconds"
            label="Seconds per slide"
            min={3}
            max={3600}
            value={widget.seconds}
            onChange={(_, { value }) => {
              const next = clampInt(value, 3, 3600);
              if (next !== null) onChange({ ...widget, seconds: next });
            }}
          />
        </>
      );
    }
    case 'text':
      return (
        <>
          <CodeArea
            id="wf-text"
            label="Text"
            rows={widget.format && widget.format !== 'plain' ? 8 : 4}
            maxCount={LIMITS.text}
            value={widget.text}
            invalidText={error?.startsWith('Text is limited') ? error : undefined}
            onChange={(text) => onChange({ ...widget, text })}
          />
          <FormatSelect
            id="wf-text-format"
            value={formatOf(widget)}
            onChange={(format) => onChange(withRichText(widget, { format }))}
          />
          <RichTextAdvanced id="wf-text" widget={widget} assets={assets} onChange={(next) => onChange(next)} />
          {fieldError}
        </>
      );
    case 'qr':
      return (
        <>
          <TextInput
            id="wf-url"
            labelText="URL"
            helperText="Must start with https://"
            invalid={Boolean(error)}
            invalidText={error ?? ''}
            value={widget.url}
            onChange={(event) => onChange({ ...widget, url: event.target.value })}
          />
          <TextInput
            id="wf-caption"
            labelText="Caption"
            maxLength={200}
            value={widget.caption}
            onChange={(event) => onChange({ ...widget, caption: event.target.value })}
          />
        </>
      );
    case 'clock':
      return (
        <RadioButtonGroup
          legendText="Shows"
          name="wf-clock"
          valueSelected={widget.mode}
          onChange={(value) => onChange({ ...widget, mode: value as SignageClockWidget['mode'] })}
        >
          <RadioButton id="wf-clock-time" value="time" labelText="Time" />
          <RadioButton id="wf-clock-datetime" value="datetime" labelText="Date and time" />
          <RadioButton id="wf-clock-date" value="date" labelText="Date only" />
        </RadioButtonGroup>
      );
    case 'camera': {
      const cameraOptions: Option[] = machines
        .filter((machine) => machine.hasCamera)
        .map((machine) => ({ id: machine.id, label: machine.name }));
      const selected = widget.machineId;
      return (
        <>
          {machinesKnown && cameraOptions.length === 0 && <NoCameraNote />}
          <Select
            id="wf-source"
            labelText="Source"
            value={widget.source}
            onChange={(event) => {
              const source = event.target.value as 'machine' | 'auto';
              onChange({
                ...widget,
                source,
                machineId: source === 'auto' ? null : widget.machineId,
                machineIds: source === 'auto' ? widget.machineIds : [],
              });
            }}
          >
            <SelectItem value="auto" text="Active machine (auto)" />
            <SelectItem value="machine" text="Specific machine" />
          </Select>
          {widget.source === 'machine' && (
            <Select
              id="wf-machine"
              labelText="Machine"
              invalid={!selected}
              invalidText="Choose a machine"
              value={selected ?? ''}
              onChange={(event) => onChange({ ...widget, machineId: event.target.value || null })}
            >
              <SelectItem value="" text="Choose a machine" />
              {selected && !cameraOptions.some((option) => option.id === selected) && (
                <SelectItem value={selected} text={machineName(selected)} />
              )}
              {cameraOptions.map((option) => (
                <SelectItem key={option.id} value={option.id} text={option.label} />
              ))}
            </Select>
          )}
          {widget.source === 'auto' && (
            <>
              <MultiSelect<Option>
                id="wf-camera-machines"
                key={cameraOptions.map((option) => option.id).join(',')}
                titleText="Machines"
                label="All machines with a camera"
                items={cameraOptions}
                itemToString={(item) => item?.label ?? ''}
                helperText="The camera shows the first of these machines that prints. Leave empty to use every machine with a camera."
                initialSelectedItems={(widget.machineIds ?? []).map((id) => ({ id, label: machineName(id) }))}
                onChange={({ selectedItems }) =>
                  onChange({ ...widget, machineIds: (selectedItems ?? []).map((item) => item.id) })
                }
              />
              <RadioButtonGroup
                legendText="When several machines print"
                name="wf-multi"
                valueSelected={widget.multi}
                onChange={(value) => onChange({ ...widget, multi: value as 'split' | 'alternate' })}
              >
                <RadioButton id="wf-multi-split" value="split" labelText="Split screen" />
                <RadioButton id="wf-multi-alt" value="alternate" labelText="Alternate" />
              </RadioButtonGroup>
            </>
          )}
          <Toggle
            id="wf-progress"
            size="sm"
            labelText="Overlay progress"
            labelA="Off"
            labelB="On"
            toggled={widget.showProgress}
            onToggle={(showProgress) => onChange({ ...widget, showProgress })}
          />
          <Toggle
            id="wf-remaining"
            size="sm"
            labelText="Overlay remaining time"
            labelA="Off"
            labelB="On"
            toggled={widget.showRemaining}
            onToggle={(showRemaining) => onChange({ ...widget, showRemaining })}
          />
          <Toggle
            id="wf-show-live"
            size="sm"
            labelText="Show the live picture"
            labelA="Off"
            labelB="On"
            toggled={widget.showLive}
            onToggle={(showLive) => onChange({ ...widget, showLive })}
          />
          <Toggle
            id="wf-show-name"
            size="sm"
            labelText="Show the machine name"
            labelA="Off"
            labelB="On"
            toggled={widget.showName}
            onToggle={(showName) => onChange({ ...widget, showName })}
          />
          <Select
            id="wf-fallback"
            labelText="When the camera is unavailable"
            value={widget.fallback}
            onChange={(event) => {
              const fallback = event.target.value as 'image' | 'text' | 'hide';
              onChange({ ...widget, fallback, fallbackMediaId: fallback === 'image' ? widget.fallbackMediaId : null });
            }}
          >
            <SelectItem value="image" text="Show image" />
            <SelectItem value="text" text="Show status text" />
            <SelectItem value="hide" text="Hide the block" />
          </Select>
          {widget.fallback === 'image' && (
            <MediaPicker
              id="wf-fallback-image"
              labelText="Fallback image"
              kind="image"
              value={widget.fallbackMediaId}
              onChange={(fallbackMediaId) => onChange({ ...widget, fallbackMediaId })}
            />
          )}
          <p className="sg-secondary">
            The live camera appears on the display while the machine prints. Previews show a neutral frame. Cameras are
            set up under Settings, Local services.
          </p>
          {outsideDisplays.length > 0 && (
            <InlineNotification
              kind="warning"
              lowContrast
              hideCloseButton
              title="Camera not shown on outside displays"
              subtitle={`On ${outsideDisplays.join(', ')} this camera shows its fallback, because live cameras are not allowed there.`}
            />
          )}
        </>
      );
    }
    case 'status':
      return (
        <>
          <MultiSelect<Option>
            id="wf-status-machines"
            key={machineOptions.map((item) => item.id).join(',')}
            titleText="Machines"
            label="Choose machines"
            helperText={machinesHint}
            items={machineOptions}
            itemToString={(item) => item?.label ?? ''}
            initialSelectedItems={widget.machineIds.map((id) => ({ id, label: machineName(id) }))}
            onChange={({ selectedItems }) =>
              onChange({ ...widget, machineIds: (selectedItems ?? []).map((item) => item.id) })
            }
          />
          <Toggle
            id="wf-status-progress"
            size="sm"
            labelText="Show progress"
            labelA="Off"
            labelB="On"
            toggled={widget.showProgress}
            onToggle={(showProgress) => onChange({ ...widget, showProgress })}
          />
          <Toggle
            id="wf-status-remaining"
            size="sm"
            labelText="Show remaining time"
            labelA="Off"
            labelB="On"
            toggled={widget.showRemaining}
            onToggle={(showRemaining) => onChange({ ...widget, showRemaining })}
          />
          <p className="sg-secondary">Only machine name, state and progress. Never customer names or prices.</p>
        </>
      );
    case 'open_days':
    case 'events':
    case 'agenda':
      return <ListFields widget={widget} assets={assets} error={error} onChange={onChange} />;
    case 'calendar':
      return <CalendarFields widget={widget} onChange={onChange} />;
    case 'timelapse':
      return <TimelapseFields widget={widget} machines={machines} onChange={onChange} />;
    case 'announcement':
      return (
        <>
          <MultiSelect<Option>
            id="wf-ann-templates"
            titleText="Show announcements from"
            label="All templates"
            items={templates.map((item) => ({ id: item.id, label: item.name }))}
            itemToString={(item) => item?.label ?? ''}
            initialSelectedItems={templates
              .filter((item) => widget.templateIds.includes(item.id))
              .map((item) => ({ id: item.id, label: item.name }))}
            helperText="Leave empty to show every announcement that targets the display."
            onChange={({ selectedItems }) =>
              onChange({ ...widget, templateIds: (selectedItems ?? []).map((item) => item.id) })
            }
          />
          <Select
            id="wf-ann-style"
            labelText="Style"
            value={widget.style}
            onChange={(event) => onChange({ ...widget, style: event.target.value as 'banner' | 'card' | 'full' })}
          >
            <SelectItem value="banner" text="Banner (one slim line)" />
            <SelectItem value="card" text="Card" />
            <SelectItem value="full" text="Full block" />
          </Select>
          <Select
            id="wf-ann-none"
            labelText="When none is active"
            value={widget.whenNone}
            onChange={(event) => onChange({ ...widget, whenNone: event.target.value as 'empty' | 'text' })}
          >
            <SelectItem value="empty" text="Leave the block empty" />
            <SelectItem value="text" text="Show fallback text" />
          </Select>
          {widget.whenNone === 'text' && (
            <TextInput
              id="wf-ann-fallback"
              labelText="Fallback text"
              maxLength={500}
              value={widget.fallbackText}
              onChange={(event) => onChange({ ...widget, fallbackText: event.target.value })}
            />
          )}
          <Select
            id="wf-ann-many"
            labelText="When several are active"
            value={widget.whenMany}
            onChange={(event) => onChange({ ...widget, whenMany: event.target.value as 'rotate' | 'newest' | 'stack' })}
          >
            <SelectItem value="rotate" text="Rotate" />
            <SelectItem value="newest" text="Show the newest" />
            <SelectItem value="stack" text="Stack them" />
          </Select>
          {widget.whenMany === 'rotate' && (
            <NumberInput
              id="wf-ann-rotate"
              label="Rotate every (seconds)"
              min={3}
              max={300}
              value={widget.rotateSeconds}
              onChange={(_, { value }) => {
                const next = clampInt(value, 3, 300);
                if (next !== null) onChange({ ...widget, rotateSeconds: next });
              }}
            />
          )}
          <p className="sg-secondary">
            Announcements are live: they appear on the display as soon as they start, without publishing.
          </p>
        </>
      );
  }
}
