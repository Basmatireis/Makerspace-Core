import {
  Button,
  ContainedList,
  ContainedListItem,
  InlineNotification,
  Link as CarbonLink,
  Modal,
  OverflowMenu,
  OverflowMenuItem,
} from '@carbon/react';
import { Calendar, Events } from '@carbon/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ComingUpItem } from '../../api/generated/models';
import { leaveOpenDay } from '../../api/generated/open-days/open-days';
import { when } from './format';
import { dashboardKeys } from './queries';

type Props = {
  items: ComingUpItem[];
  now: number;
  canLeave: boolean;
  canFindOpenDays: boolean;
};

/** Open-day duties and event shifts in one chronological list; the icon tells them apart. */
export function ComingUpPanel({ items, now, canLeave, canFindOpenDays }: Props) {
  const client = useQueryClient();
  const [leaving, setLeaving] = useState<ComingUpItem | null>(null);
  const leave = useMutation({
    mutationFn: (openDayId: string) => leaveOpenDay(openDayId),
    onSuccess: async () => {
      setLeaving(null);
      await client.invalidateQueries({ queryKey: dashboardKeys.personal() });
    },
  });

  return (
    <>
      <ContainedList
        label="Coming up"
        kind="on-page"
        className="db-panel"
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
            const canLeaveThis = openDay && canLeave && item.openDayId !== undefined;
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
      <Modal
        open={leaving !== null}
        danger
        size="xs"
        modalHeading="Leave this open day?"
        primaryButtonText={leave.isPending ? 'Leaving…' : 'Leave open day'}
        secondaryButtonText="Stay signed up"
        primaryButtonDisabled={leave.isPending}
        onRequestClose={() => {
          leave.reset();
          setLeaving(null);
        }}
        onRequestSubmit={() => {
          if (leaving?.openDayId) leave.mutate(leaving.openDayId);
        }}
      >
        {leaving && (
          <p>
            {leaving.title}: {when(leaving.startsAt, leaving.endsAt, now)}. The Leitung sees the open place on the
            staffing page.
          </p>
        )}
        {leave.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Could not leave the open day"
            subtitle="Try again in a moment."
          />
        )}
      </Modal>
    </>
  );
}
