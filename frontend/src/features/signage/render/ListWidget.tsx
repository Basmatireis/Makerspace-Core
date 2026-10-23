import type { SignageAgendaWidget, SignageEventsWidget, SignageOpenDaysWidget } from '../../../api/generated/models';
import { dateText, timeText, wallTime } from './dates';
import { entriesDocument, eventEntry, mergeAgenda, openDayEntry, type ListEntry } from './entries';
import { CompetencyChips } from './CompetencyChips';
import { RichText } from './RichTextView';
import type { RenderData } from './types';

// The open day, event and agenda widgets: a heading and either the previous row layout or, when a template is set,
// one rich text document with a wrapped entry per item.

type ListWidgetProps = {
  widget: SignageOpenDaysWidget | SignageEventsWidget | SignageAgendaWidget;
  data: RenderData;
};

const DEFAULT_TEXT = {
  open_days: { title: 'Next open days', empty: 'No open days planned' },
  events: { title: 'Upcoming events', empty: 'No events planned' },
  agenda: { title: 'Agenda', empty: 'Nothing planned' },
} as const;

function entriesOf({ widget, data }: ListWidgetProps): ListEntry[] {
  if (widget.type === 'open_days') return data.openDays.slice(0, widget.count).map(openDayEntry);
  if (widget.type === 'events') return data.events.slice(0, widget.count).map(eventEntry);
  return mergeAgenda(data.openDays, data.events, widget);
}

function templatesOf(widget: ListWidgetProps['widget']): { open_day?: string; event?: string } {
  if (widget.type === 'open_days') return { open_day: widget.entryTemplate };
  if (widget.type === 'events') return { event: widget.entryTemplate };
  return { open_day: widget.openDayTemplate, event: widget.eventTemplate };
}

/** Planned competencies of the standard open-day row: the first few, then "+n". */
const ROW_COMPETENCIES = 4;

function Row({
  entry,
  timeZone,
  showCompetencies,
}: {
  entry: ListEntry;
  timeZone: string | undefined;
  showCompetencies: boolean;
}) {
  const start = wallTime(entry.startsAt, timeZone);
  if (entry.kind === 'open_day') {
    const row = (
      <div className="sg-list__row">
        <span>{dateText(start)}</span>
        <span>
          {timeText(start)}–{entry.endsAt ? timeText(wallTime(entry.endsAt, timeZone)) : ''}
        </span>
      </div>
    );
    if (!showCompetencies || entry.competencies.length === 0) return row;
    return (
      <div className="sg-list__item">
        {row}
        <CompetencyChips labels={entry.competencies} limit={ROW_COMPETENCIES} />
      </div>
    );
  }
  return (
    <div className="sg-list__row">
      <span>{entry.title}</span>
      <span>
        {dateText(start)} {timeText(start)}
      </span>
    </div>
  );
}

export function ListWidget({ widget, data }: ListWidgetProps) {
  const defaults = DEFAULT_TEXT[widget.type];
  const heading = widget.title ?? defaults.title;
  const emptyText = widget.emptyText ?? defaults.empty;
  const entries = entriesOf({ widget, data });
  const templates = templatesOf(widget);
  const format = widget.format ?? 'plain';
  const useTemplates = Object.values(templates).some((template) => template?.trim());
  return (
    <div className="sg-list">
      {heading !== '' && <strong className="sg-list__title">{heading}</strong>}
      {entries.length === 0 ? (
        emptyText !== '' && <span className="sg-list__empty">{emptyText}</span>
      ) : useTemplates ? (
        <RichText
          className="sg-list__document"
          format={format}
          css={widget.css}
          text={entriesDocument(entries, templates, format, data.timeZone)}
        />
      ) : (
        entries.map((entry) => (
          <Row
            key={`${entry.kind}-${entry.startsAt}-${entry.title}`}
            entry={entry}
            timeZone={data.timeZone}
            showCompetencies={widget.type !== 'events' && widget.showCompetencies === true}
          />
        ))
      )}
    </div>
  );
}
