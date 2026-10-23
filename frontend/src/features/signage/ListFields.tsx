import { Checkbox, NumberInput, Select, SelectItem, TextArea, TextInput } from '@carbon/react';
import type { SignageAsset, SignageWidget } from '../../api/generated/models';
import { CodeArea, RichTextOptions } from './RichTextFields';
import { clampInt, ENTRY_PLACEHOLDERS, LIMITS, withField } from './widgets';

type ListWidget = Extract<SignageWidget, { type: 'open_days' | 'events' | 'agenda' }>;

const placeholdersFor = (kind: 'open_day' | 'event') =>
  ENTRY_PLACEHOLDERS.filter((item) => item.for === 'both' || item.for === kind);

/** The default heading, no heading (an empty title) or a custom one. */
function HeadingField({
  id,
  title,
  fallback,
  onChange,
}: {
  id: string;
  title: string | undefined;
  fallback: string;
  onChange: (title: string | undefined) => void;
}) {
  const mode = title === undefined ? 'default' : title === '' ? 'none' : 'custom';
  return (
    <>
      <Select
        id={`${id}-heading`}
        labelText="Heading"
        value={mode}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === 'default' ? undefined : next === 'none' ? '' : fallback);
        }}
      >
        <SelectItem value="default" text="Default heading" />
        <SelectItem value="custom" text="Custom heading" />
        <SelectItem value="none" text="No heading" />
      </Select>
      {mode === 'custom' && (
        <TextInput
          id={`${id}-title`}
          labelText="Heading text"
          maxLength={LIMITS.listTitle}
          value={title ?? ''}
          onChange={(event) => onChange(event.target.value.replace(/[\r\n]+/g, ' '))}
        />
      )}
    </>
  );
}

/** Drops an emptied optional text so the widget keeps the previous look. */
const setText = <W extends ListWidget>(widget: W, key: string, value: string): W =>
  withField(widget, key, value === '' ? undefined : value);

type Props = {
  widget: ListWidget;
  assets: readonly SignageAsset[];
  onChange: (widget: SignageWidget) => void;
  error: string | null;
};

/** Open days, events and agenda lists: count, heading, empty text, entry templates, rich text options. */
export function ListFields({ widget, assets, onChange, error }: Props) {
  const id = `wf-${widget.type}`;
  const noun = widget.type === 'open_days' ? 'open days' : widget.type === 'events' ? 'events' : 'entries';
  const headingFallback =
    widget.type === 'open_days' ? 'Next open days' : widget.type === 'events' ? 'Next events' : 'Agenda';
  return (
    <>
      <NumberInput
        id={`${id}-count`}
        label={`Show the next … ${noun}`}
        min={1}
        max={LIMITS.listCount}
        value={widget.count}
        invalid={error?.startsWith('Choose between')}
        invalidText={error ?? ''}
        onChange={(_, { value }) => {
          const count = clampInt(value, 1, LIMITS.listCount);
          if (count !== null) onChange({ ...widget, count });
        }}
      />
      {widget.type === 'agenda' && (
        <fieldset className="sg-fieldset">
          <legend className="cds--label">Include</legend>
          <Checkbox
            id="wf-agenda-open-days"
            labelText="Open days"
            checked={widget.includeOpenDays}
            onChange={(_, { checked }) => onChange({ ...widget, includeOpenDays: checked })}
          />
          <Checkbox
            id="wf-agenda-events"
            labelText="Events"
            checked={widget.includeEvents}
            onChange={(_, { checked }) => onChange({ ...widget, includeEvents: checked })}
          />
        </fieldset>
      )}
      <HeadingField
        id={id}
        title={widget.title}
        fallback={headingFallback}
        onChange={(title) => onChange(withField(widget, 'title', title))}
      />
      <TextArea
        id={`${id}-empty`}
        labelText="Text when there is nothing to show"
        rows={2}
        maxCount={LIMITS.listEmpty}
        enableCounter
        value={widget.emptyText ?? ''}
        onChange={(event) => onChange(setText(widget, 'emptyText', event.target.value))}
      />
      {widget.type === 'agenda' ? (
        <>
          <CodeArea
            id={`${id}-open-day-template`}
            label="Open day template"
            rows={3}
            maxCount={LIMITS.entryTemplate}
            value={widget.openDayTemplate ?? ''}
            helperText="One per open day, in the format below. Empty keeps the standard row."
            placeholders={placeholdersFor('open_day')}
            onChange={(value) => onChange(setText(widget, 'openDayTemplate', value))}
          />
          <CodeArea
            id={`${id}-event-template`}
            label="Event template"
            rows={3}
            maxCount={LIMITS.entryTemplate}
            value={widget.eventTemplate ?? ''}
            helperText="One per event. Empty keeps the standard row."
            placeholders={placeholdersFor('event')}
            onChange={(value) => onChange(setText(widget, 'eventTemplate', value))}
          />
        </>
      ) : (
        <CodeArea
          id={`${id}-template`}
          label="Entry template"
          rows={3}
          maxCount={LIMITS.entryTemplate}
          value={widget.entryTemplate ?? ''}
          helperText="One per entry, in the format below. Empty keeps the standard row."
          placeholders={placeholdersFor(widget.type === 'open_days' ? 'open_day' : 'event')}
          onChange={(value) => onChange(setText(widget, 'entryTemplate', value))}
        />
      )}
      {widget.type !== 'events' && (
        <Checkbox
          id={`${id}-competencies`}
          labelText="Show planned competencies"
          helperText="Adds the competencies of the assigned supervisors, such as 3D printing, to each open day in the standard row. Templates use {competencies}."
          checked={widget.showCompetencies === true}
          onChange={(_, { checked }) => onChange(withField(widget, 'showCompetencies', checked || undefined))}
        />
      )}
      <RichTextOptions id={id} widget={widget} assets={assets} onChange={onChange} />
      {widget.type !== 'open_days' && widget.type !== 'events' && !widget.includeOpenDays && !widget.includeEvents && (
        <p className="sg-error-text">Nothing is included, so the agenda always shows its empty text.</p>
      )}
    </>
  );
}
