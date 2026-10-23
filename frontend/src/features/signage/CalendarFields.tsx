import { NumberInput, RadioButton, RadioButtonGroup, TextInput, Toggle } from '@carbon/react';
import type { SignageCalendarColors, SignageCalendarWidget } from '../../api/generated/models';
import { ColorField } from './WidgetStyleFields';
import { clampInt, LIMITS, withField } from './widgets';

type Category = {
  show: 'showHolidays' | 'showBreaks' | 'showOpenDays' | 'showEvents';
  color: keyof SignageCalendarColors;
  label: string;
};
const CATEGORIES: Category[] = [
  { show: 'showHolidays', color: 'holiday', label: 'Holidays' },
  { show: 'showBreaks', color: 'break', label: 'Academic breaks' },
  { show: 'showOpenDays', color: 'openDay', label: 'Open days' },
  { show: 'showEvents', color: 'event', label: 'Events' },
];

/** Calendar widget: month or the next weeks, which categories appear and in which colour. */
export function CalendarFields({
  widget,
  onChange,
}: {
  widget: SignageCalendarWidget;
  onChange: (widget: SignageCalendarWidget) => void;
}) {
  return (
    <>
      <RadioButtonGroup
        legendText="View"
        name="wf-calendar-view"
        valueSelected={widget.view}
        onChange={(value) => onChange({ ...widget, view: value as 'month' | 'weeks' })}
      >
        <RadioButton id="wf-calendar-month" value="month" labelText="Current month" />
        <RadioButton id="wf-calendar-weeks" value="weeks" labelText="Next weeks" />
      </RadioButtonGroup>
      {widget.view === 'weeks' && (
        <NumberInput
          id="wf-calendar-weeks-count"
          label="Weeks to show"
          helperText="Starting with the current week"
          min={1}
          max={LIMITS.calendarWeeks}
          value={widget.weeks}
          onChange={(_, { value }) => {
            const weeks = clampInt(value, 1, LIMITS.calendarWeeks);
            if (weeks !== null) onChange({ ...widget, weeks });
          }}
        />
      )}
      <TextInput
        id="wf-calendar-title"
        labelText="Title (optional)"
        helperText="Leave empty to hide the title."
        maxLength={LIMITS.listTitle}
        value={widget.title ?? ''}
        onChange={(event) => onChange(withField(widget, 'title', event.target.value || undefined))}
      />
      <fieldset className="sg-fieldset">
        <legend className="cds--label">Show</legend>
        {CATEGORIES.map((category) => (
          <div className="sg-category-row" key={category.show}>
            <Toggle
              id={`wf-calendar-${category.show}`}
              size="sm"
              labelText={category.label}
              labelA="Off"
              labelB="On"
              toggled={widget[category.show]}
              onToggle={(checked) => onChange({ ...widget, [category.show]: checked })}
            />
            <ColorField
              id={`wf-calendar-color-${category.color}`}
              label={`${category.label} colour`}
              nullable={false}
              value={widget.colors[category.color]}
              onChange={(color) => {
                if (color) onChange({ ...widget, colors: { ...widget.colors, [category.color]: color } });
              }}
            />
          </div>
        ))}
      </fieldset>
      <Toggle
        id="wf-calendar-week-numbers"
        size="sm"
        labelText="Week numbers"
        labelA="Off"
        labelB="On"
        toggled={widget.showWeekNumbers}
        onToggle={(showWeekNumbers) => onChange({ ...widget, showWeekNumbers })}
      />
      {widget.showOpenDays && (
        <Toggle
          id="wf-calendar-competencies"
          size="sm"
          labelText="Planned competencies on open days"
          labelA="Off"
          labelB="On"
          toggled={widget.showCompetencies === true}
          disabled={widget.view === 'month'}
          onToggle={(checked) => onChange(withField(widget, 'showCompetencies', checked || undefined))}
        />
      )}
      {widget.showOpenDays && widget.view === 'month' && (
        <p className="sg-secondary">Month cells are too small for competencies; the weeks view shows the first two.</p>
      )}
      <p className="sg-secondary">Weeks start on Monday. Dates are shown in the makerspace time zone.</p>
    </>
  );
}
