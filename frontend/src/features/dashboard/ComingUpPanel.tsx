import {
  Button,
  ContainedList,
  ContainedListItem,
  Link as CarbonLink,
  OverflowMenu,
  OverflowMenuItem,
} from '@carbon/react';
import { Calendar, Events } from '@carbon/icons-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ComingUpItem } from '../../api/generated/models';
import { leavable, when } from './format';
import { LeaveOpenDayModal } from './LeaveOpenDay';
type Props = {
  items: ComingUpItem[];
  now: number;
  canLeave: boolean;
  canFindOpenDays: boolean;
};

/** Open-day duties and event shifts in one chronological list; the icon tells them apart. */
export function ComingUpPanel({ items, now, canLeave, canFindOpenDays }: Props) {
  const [leaving, setLeaving] = useState<ComingUpItem | null>(null);

  return (
    <>
      <ContainedList
        label="Coming up"
        kind="on-page"
        className="db-panel"
        data-guide="dashboard-coming-up"
        action={
          canFindOpenDays ? (
            <Button as={Link} to="/open-days" kind="ghost" size="sm">
              Open days
            </Button>
          ) : undefined
        }
      >
        {items.length === 0 ? (
          <ContainedListItem>
            <span className="db-panel__empty">Nothing booked. Join an open day or an event shift.</span>
          </ContainedListItem>
        ) : (
          items.map((item) => {
            const range = when(item.startsAt, item.endsAt, now);
            const openDay = item.kind === 'open_day';
            const canLeaveThis = leavable(item, canLeave);
            return (
              <ContainedListItem
                key={`${item.kind}-${item.id}`}
                renderIcon={openDay ? Calendar : Events}
                action={
                  canLeaveThis ? (
                    <OverflowMenu iconDescription={`Actions for ${item.title} ${range}`} size="sm" flipped>
                      <OverflowMenuItem itemText="Leave open day" isDelete onClick={() => setLeaving(item)} />
                    </OverflowMenu>
                  ) : undefined
                }
              >
                <div className="db-item">
                  <span className="db-item__title">
                    {openDay && canFindOpenDays && item.periodId && item.openDayId ? (
                      <CarbonLink as={Link} to={`/open-days/${item.periodId}/days/${item.openDayId}`}>
                        {item.title}
                      </CarbonLink>
                    ) : (
                      item.title
                    )}
                  </span>
                  <span className="db-item__meta">
                    {range}
                    {item.shortStaffed ? ' · needs supervisors' : ''}
                  </span>
                </div>
              </ContainedListItem>
            );
          })
        )}
      </ContainedList>
      <LeaveOpenDayModal item={leaving} now={now} onClose={() => setLeaving(null)} />
    </>
  );
}
