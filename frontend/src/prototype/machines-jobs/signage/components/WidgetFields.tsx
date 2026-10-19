import { ComboBox, ContainedList, ContainedListItem, IconButton, InlineNotification, MultiSelect, NumberInput, RadioButton, RadioButtonGroup, Select, SelectItem, TextArea, TextInput, Toggle } from '@carbon/react';
import { ArrowDown, ArrowUp, TrashCan } from '@carbon/icons-react';
import { MACHINE_KEYS, MACHINE_NAMES } from '../engine';
import type { AnnouncementStyle, AnnouncementTemplate, MachineKey, MediaItem, TextSize, Widget } from '../types';

type MachineOption = { id: MachineKey; label: string };
type TemplateOption = { id: string; label: string };

export function MediaPicker({ id, label, kind, media, value, onChange }: { id: string; label: string; kind: 'image' | 'video'; media: MediaItem[]; value: string | null; onChange: (id: string | null) => void }) {
  const items = media.filter((item) => item.kind === kind);
  return (
    <ComboBox<MediaItem> id={id} titleText={label} placeholder={`Choose ${kind === 'image' ? 'an image' : 'a video'} from Media`} items={items} itemToString={(item) => item?.name ?? ''} selectedItem={items.find((item) => item.id === value) ?? null}
      onChange={({ selectedItem }) => onChange(selectedItem?.id ?? null)} />
  );
}

export function FitField({ id, value, onChange }: { id: string; value: 'contain' | 'cover'; onChange: (fit: 'contain' | 'cover') => void }) {
  return (
    <Select id={id} labelText="Fit" value={value} onChange={(event) => onChange(event.target.value as 'contain' | 'cover')}>
      <SelectItem value="cover" text="Cover (crop to fill)" /><SelectItem value="contain" text="Contain (show everything)" />
    </Select>
  );
}

/** Widget-specific properties of the selected zone. Every change is applied (autosaved) immediately. */
export function WidgetFields({ widget, media, templates, outsideDisplays, onChange }: { widget: Widget; media: MediaItem[]; templates: AnnouncementTemplate[]; outsideDisplays: string[]; onChange: (widget: Widget) => void }) {
  switch (widget.type) {
    case 'empty': return <p className="mj-secondary">This zone is empty. Choose a widget type to fill it.</p>;
    case 'image': return (
      <>
        <MediaPicker id="wf-image" label="Image" kind="image" media={media} value={widget.mediaId} onChange={(mediaId) => onChange({ ...widget, mediaId })} />
        <FitField id="wf-fit" value={widget.fit} onChange={(fit) => onChange({ ...widget, fit })} />
      </>
    );
    case 'video': return (
      <>
        <MediaPicker id="wf-video" label="Video" kind="video" media={media} value={widget.mediaId} onChange={(mediaId) => onChange({ ...widget, mediaId })} />
        <FitField id="wf-fit" value={widget.fit} onChange={(fit) => onChange({ ...widget, fit })} />
        <p className="mj-secondary">Videos always play muted and in a loop.</p>
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
                  <span className="sg-slide-row__name">{media.find((item) => item.id === mediaId)?.name ?? 'Removed media'}</span>
                  <IconButton label="Move up" kind="ghost" size="sm" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp /></IconButton>
                  <IconButton label="Move down" kind="ghost" size="sm" disabled={index === widget.mediaIds.length - 1} onClick={() => move(index, 1)}><ArrowDown /></IconButton>
                  <IconButton label="Remove slide" kind="ghost" size="sm" onClick={() => onChange({ ...widget, mediaIds: widget.mediaIds.filter((_, at) => at !== index) })}><TrashCan /></IconButton>
                </div>
              </ContainedListItem>
            ))}
          </ContainedList>
          <ComboBox<MediaItem> id="wf-slide-add" titleText="Add slide" placeholder="Choose an image" items={media.filter((item) => item.kind === 'image')} itemToString={(item) => item?.name ?? ''} selectedItem={null}
            onChange={({ selectedItem }) => { if (selectedItem) onChange({ ...widget, mediaIds: [...widget.mediaIds, selectedItem.id] }); }} />
          <NumberInput id="wf-seconds" label="Seconds per slide" min={2} max={120} value={widget.seconds} onChange={(_, { value }) => onChange({ ...widget, seconds: Number(value) || 8 })} />
        </>
      );
    }
    case 'text': return (
      <>
        <TextArea id="wf-text" labelText="Text" rows={4} value={widget.text} onChange={(event) => onChange({ ...widget, text: event.target.value })} />
        <Select id="wf-size" labelText="Size" value={widget.size} onChange={(event) => onChange({ ...widget, size: event.target.value as TextSize })}>
          <SelectItem value="s" text="S" /><SelectItem value="m" text="M" /><SelectItem value="l" text="L" /><SelectItem value="xl" text="XL" />
        </Select>
        <RadioButtonGroup legendText="Alignment" name="wf-align" valueSelected={widget.align} onChange={(value) => onChange({ ...widget, align: value as 'start' | 'center' | 'end' })}>
          <RadioButton id="wf-align-start" value="start" labelText="Left" /><RadioButton id="wf-align-center" value="center" labelText="Centre" /><RadioButton id="wf-align-end" value="end" labelText="Right" />
        </RadioButtonGroup>
      </>
    );
    case 'qr': return (
      <>
        <TextInput id="wf-url" labelText="URL" value={widget.url} onChange={(event) => onChange({ ...widget, url: event.target.value })} />
        <TextInput id="wf-caption" labelText="Caption" value={widget.caption} onChange={(event) => onChange({ ...widget, caption: event.target.value })} />
      </>
    );
    case 'clock': return (
      <RadioButtonGroup legendText="Shows" name="wf-clock" valueSelected={widget.mode} onChange={(value) => onChange({ ...widget, mode: value as 'time' | 'datetime' })}>
        <RadioButton id="wf-clock-time" value="time" labelText="Time" /><RadioButton id="wf-clock-datetime" value="datetime" labelText="Date and time" />
      </RadioButtonGroup>
    );
    case 'camera': return (
      <>
        <Select id="wf-source" labelText="Source" value={widget.source} onChange={(event) => onChange({ ...widget, source: event.target.value as 'machine' | 'auto' })}>
          <SelectItem value="auto" text="Active machine (auto)" /><SelectItem value="machine" text="Specific machine" />
        </Select>
        {widget.source === 'machine' && (
          <Select id="wf-machine" labelText="Machine" value={widget.machineId} onChange={(event) => onChange({ ...widget, machineId: event.target.value as MachineKey })}>
            {MACHINE_KEYS.map((key) => <SelectItem key={key} value={key} text={MACHINE_NAMES[key]} />)}
          </Select>
        )}
        {widget.source === 'auto' && (
          <RadioButtonGroup legendText="When several machines print" name="wf-multi" valueSelected={widget.multi} onChange={(value) => onChange({ ...widget, multi: value as 'split' | 'alternate' })}>
            <RadioButton id="wf-multi-split" value="split" labelText="Split screen" /><RadioButton id="wf-multi-alt" value="alternate" labelText="Alternate" />
          </RadioButtonGroup>
        )}
        <Toggle id="wf-progress" size="sm" labelText="Overlay progress" labelA="Off" labelB="On" toggled={widget.showProgress} onToggle={(showProgress) => onChange({ ...widget, showProgress })} />
        <Toggle id="wf-remaining" size="sm" labelText="Overlay remaining time" labelA="Off" labelB="On" toggled={widget.showRemaining} onToggle={(showRemaining) => onChange({ ...widget, showRemaining })} />
        <Select id="wf-fallback" labelText="When the camera is unavailable" value={widget.fallback} onChange={(event) => onChange({ ...widget, fallback: event.target.value as 'image' | 'text' | 'hide' })}>
          <SelectItem value="image" text="Show image" /><SelectItem value="text" text="Show status text" /><SelectItem value="hide" text="Hide zone" />
        </Select>
        {widget.fallback === 'image' && <MediaPicker id="wf-fallback-image" label="Fallback image" kind="image" media={media} value={widget.fallbackMediaId} onChange={(fallbackMediaId) => onChange({ ...widget, fallbackMediaId })} />}
        {outsideDisplays.length > 0 && <InlineNotification kind="warning" lowContrast hideCloseButton title="Visible from outside" subtitle={`${outsideDisplays.join(', ')} ${outsideDisplays.length === 1 ? 'is' : 'are'} visible from outside. Check the camera does not show people or documents.`} />}
      </>
    );
    case 'status': return (
      <>
        <MultiSelect<MachineOption> id="wf-status-machines" titleText="Machines" label="Choose machines" items={MACHINE_KEYS.map((key) => ({ id: key, label: MACHINE_NAMES[key] }))} itemToString={(item) => item?.label ?? ''}
          initialSelectedItems={MACHINE_KEYS.filter((key) => widget.machineIds.includes(key)).map((key) => ({ id: key, label: MACHINE_NAMES[key] }))}
          onChange={({ selectedItems }) => onChange({ ...widget, machineIds: (selectedItems ?? []).map((item) => item.id) })} />
        <Toggle id="wf-status-progress" size="sm" labelText="Show progress" labelA="Off" labelB="On" toggled={widget.showProgress} onToggle={(showProgress) => onChange({ ...widget, showProgress })} />
        <Toggle id="wf-status-remaining" size="sm" labelText="Show remaining time" labelA="Off" labelB="On" toggled={widget.showRemaining} onToggle={(showRemaining) => onChange({ ...widget, showRemaining })} />
        <p className="mj-secondary">Only machine name, state and progress. Never customer names or prices.</p>
      </>
    );
    case 'open_days': return <NumberInput id="wf-open-days" label="Show the next … open days" min={1} max={5} value={widget.count} onChange={(_, { value }) => onChange({ ...widget, count: Math.min(5, Math.max(1, Number(value) || 1)) })} />;
    case 'announcement': return (
      <>
        <MultiSelect<TemplateOption> id="wf-ann-templates" titleText="Show announcements from" label="All templates" items={templates.map((item) => ({ id: item.id, label: item.name }))} itemToString={(item) => item?.label ?? ''}
          initialSelectedItems={templates.filter((item) => widget.templateIds.includes(item.id)).map((item) => ({ id: item.id, label: item.name }))}
          helperText="Leave empty to show every announcement that targets the display."
          onChange={({ selectedItems }) => onChange({ ...widget, templateIds: (selectedItems ?? []).map((item) => item.id) })} />
        <Select id="wf-ann-style" labelText="Style" value={widget.style} onChange={(event) => onChange({ ...widget, style: event.target.value as AnnouncementStyle })}>
          <SelectItem value="banner" text="Banner (one slim line)" /><SelectItem value="card" text="Card" /><SelectItem value="full" text="Full zone" />
        </Select>
        <Select id="wf-ann-size" labelText="Text size" value={widget.size} onChange={(event) => onChange({ ...widget, size: event.target.value as TextSize })}>
          <SelectItem value="s" text="S" /><SelectItem value="m" text="M" /><SelectItem value="l" text="L" /><SelectItem value="xl" text="XL" />
        </Select>
        <Select id="wf-ann-none" labelText="When none is active" value={widget.whenNone} onChange={(event) => onChange({ ...widget, whenNone: event.target.value as 'empty' | 'text' })}>
          <SelectItem value="empty" text="Leave the zone empty" /><SelectItem value="text" text="Show fallback text" />
        </Select>
        {widget.whenNone === 'text' && <TextInput id="wf-ann-fallback" labelText="Fallback text" value={widget.fallbackText} onChange={(event) => onChange({ ...widget, fallbackText: event.target.value })} />}
        <Select id="wf-ann-many" labelText="When several are active" value={widget.whenMany} onChange={(event) => onChange({ ...widget, whenMany: event.target.value as 'rotate' | 'newest' | 'stack' })}>
          <SelectItem value="rotate" text="Rotate" /><SelectItem value="newest" text="Show the newest" /><SelectItem value="stack" text="Stack them" />
        </Select>
        {widget.whenMany === 'rotate' && <NumberInput id="wf-ann-rotate" label="Rotate every (seconds)" min={2} max={120} value={widget.rotateSeconds} onChange={(_, { value }) => onChange({ ...widget, rotateSeconds: Math.min(120, Math.max(2, Number(value) || 10)) })} />}
        <p className="mj-secondary">Announcements are live: they appear on the display as soon as they start, without publishing.</p>
      </>
    );
    case 'events': return <NumberInput id="wf-events" label="Show the next … events" min={1} max={5} value={widget.count} onChange={(_, { value }) => onChange({ ...widget, count: Math.min(5, Math.max(1, Number(value) || 1)) })} />;
  }
}


