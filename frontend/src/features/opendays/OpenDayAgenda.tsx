import { Edit, Misuse, TrashCan } from '@carbon/icons-react';
import { Button, Checkbox, Tag, Tile } from '@carbon/react';
import type { ReactNode } from 'react';
import type { OpenDayPeriodStatus } from '../../api/generated/models';
import { RowActions } from '../../app/RowActions';
import { formatLongDate } from '../../app/dateTime';
import { dateInTimeZone } from './dateTime';

export type AgendaItem = {
  id: string;
  startsAt: string;
  endsAt: string;
  status?: string;
  summary: ReactNode;
  details?: ReactNode;
  disabled?: boolean;
};

export function OpenDayAgenda({
  items,
  timeZone,
  emptyMessage,
  onOpen,
  onEdit,
  onRemove,
  periodStatus,
  selectedIds,
  onSelect,
}: {
  items: AgendaItem[];
  timeZone: string;
  emptyMessage: string;
  onOpen?: (id: string) => void;
  onEdit?: (id: string) => void;
  onRemove?: (id: string) => void;
  periodStatus?: OpenDayPeriodStatus;
  selectedIds?: Set<string>;
  onSelect?: (id: string, selected: boolean) => void;
}) {
  const groups = new Map<string, AgendaItem[]>();
  [...items]
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .forEach((item) => {
      const date = dateInTimeZone(item.startsAt, timeZone);
      groups.set(date, [...(groups.get(date) ?? []), item]);
    });
  if (!items.length) return <p className="open-day-agenda__empty">{emptyMessage}</p>;

  return (
    <div className="open-day-agenda">
      {[...groups].map(([date, dayItems]) => (
        <section key={date} className="open-day-agenda__day" aria-labelledby={`agenda-${date}`}>
          <h3 id={`agenda-${date}`}>{formatLongDate(date)}</h3>
          <div className="open-day-agenda__items">
            {dayItems.map((item) => (
              <Tile key={item.id} className="open-day-agenda__item">
                {onSelect && !item.disabled && (
                  <Checkbox
                    id={`select-${item.id}`}
                    labelText={`Select Open Day ${formatLongDate(date)}`}
                    checked={selectedIds?.has(item.id) ?? false}
                    onChange={(_, { checked }) => onSelect(item.id, checked)}
                  />
                )}
                <div className="open-day-agenda__item-heading">
                  {onOpen ? (
                    <Button kind="ghost" size="md" className="open-day-agenda__open" onClick={() => onOpen(item.id)}>
                      {item.summary}
                    </Button>
                  ) : (
                    <strong>{item.summary}</strong>
                  )}
                  {item.status && <Tag type={item.status === 'cancelled' ? 'gray' : 'blue'}>{item.status}</Tag>}
                </div>
                {item.details && <div className="open-day-agenda__details">{item.details}</div>}
                {(onEdit || onRemove) && !item.disabled && (
                  <RowActions label={`Actions for ${date}`}>
                    {onEdit && (
                      <Button kind="ghost" size="sm" renderIcon={Edit} onClick={() => onEdit(item.id)}>
                        Edit
                      </Button>
                    )}
                    {onRemove && (
                      <Button
                        kind="danger--ghost"
                        size="sm"
                        renderIcon={periodStatus === 'draft' ? TrashCan : Misuse}
                        onClick={() => onRemove(item.id)}
                      >
                        {periodStatus === 'draft' ? 'Delete' : 'Cancel'}
                      </Button>
                    )}
                  </RowActions>
                )}
              </Tile>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
