import { useState } from 'react';
import { Button, IconButton, OverflowMenu, OverflowMenuItem, Tag } from '@carbon/react';
import { ArrowRight, Close, Edit } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { deleteOpenDayPeriod } from '../../../api/generated/open-days/open-days';
import type { OpenDayPeriod } from '../../../api/generated/models';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { DetailPanel, DetailPanelHead, DetailPanelSection } from '../../../app/components/DetailPanel';
import { Fact, FactsGrid } from '../../../app/components/Facts';
import { dayMonth, dayMonthYear, plural, shortDate, weekdayName } from '../model/dates';
import { slotSummary } from '../model/timeslots';
import { calendarContextQueryOptions, openDayKeys, seriesQueryOptions } from '../queries';
import { scheduleErrorMessage } from '../scheduleErrors';
import { periodRange, STATUS_TAG } from './status';
import { STATUS_HINT, transitions, type Transition } from './lifecycle';

/** The detail panel of a period: numbers, status changes, series and the holidays and breaks inside it. */
export function PeriodPanel({
  period,
  canSignUp,
  onEdit,
  onClose,
  onDeleted,
}: {
  period: OpenDayPeriod;
  canSignUp: boolean;
  onEdit: () => void;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const series = useQuery(seriesQueryOptions(period.id));
  const context = useQuery(calendarContextQueryOptions(period.id));
  const [pending, setPending] = useState<Transition | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: openDayKeys.all });
  const transition = useMutation({
    mutationFn: (item: Transition) => item.run(period),
    onSuccess: async () => {
      setPending(null);
      setError('');
      await refresh();
    },
    onError: (failure) => setError(scheduleErrorMessage(failure)),
  });
  const remove = useMutation({
    mutationFn: () => deleteOpenDayPeriod(period.id, { expectedVersion: period.version }),
    onSuccess: async () => {
      setConfirmDelete(false);
      onDeleted();
      await refresh();
    },
    onError: (failure) => setError(scheduleErrorMessage(failure)),
  });
  const status = STATUS_TAG[period.status];
  const editable = period.status !== 'archived';
  const active = period.totalOpenDays - period.cancelledCount;
  return (
    <DetailPanel className="od-detail">
      <DetailPanelHead
        title={period.name}
        meta={periodRange(period)}
        secondary="Open-day period"
        helper={
          <Tag type={status.type} size="sm">
            {status.label}
          </Tag>
        }
        actions={
          <>
            {editable && (
              <IconButton kind="ghost" size="md" label="Edit period" onClick={onEdit}>
                <Edit />
              </IconButton>
            )}
            <OverflowMenu size="md" flipped aria-label="More actions for this period" iconDescription="More actions">
              {editable && <OverflowMenuItem itemText="Edit name, dates and deadline" onClick={onEdit} />}
              <OverflowMenuItem itemText="Delete period" isDelete hasDivider onClick={() => setConfirmDelete(true)} />
            </OverflowMenu>
            <IconButton kind="ghost" size="md" label="Close details" onClick={onClose}>
              <Close />
            </IconButton>
          </>
        }
      />
      <div>
        <Button kind="primary" size="md" renderIcon={ArrowRight} as={Link} to={`/open-days/${period.id}`}>
          Open schedule
        </Button>
      </div>
      <FactsGrid columns={2}>
        <Fact label="Open days" helper={period.cancelledCount ? `${period.cancelledCount} cancelled` : undefined}>
          {active}
        </Fact>
        <Fact
          label="Fully staffed"
          helper={period.needsStaffCount ? `${period.needsStaffCount} need people` : undefined}
        >
          {period.fullyStaffedCount}
        </Fact>
        <Fact label="Open supervisor places">{period.openSupervisorPositions}</Fact>
        <Fact label="Sign-up deadline" helper={period.signUpDeadline ? undefined : 'From the staffing rules'}>
          {period.signUpDeadline ? dayMonthYear(period.signUpDeadline) : 'Default'}
        </Fact>
        {canSignUp && <Fact label="Your open days">{period.myAssignmentCount}</Fact>}
        <Fact label="Series">{series.data ? series.data.items.length : '—'}</Fact>
      </FactsGrid>
      {editable && (
        <DetailPanelSection title="Status">
          <p className="od-note-text">{STATUS_HINT[period.status]}</p>
          <div className="od-inline-actions">
            {transitions[period.status].map((item, index) => (
              <Button
                key={item.to}
                kind={index === 0 ? 'tertiary' : 'ghost'}
                size="sm"
                onClick={() => {
                  setError('');
                  setPending(item);
                }}
              >
                {item.label}
              </Button>
            ))}
          </div>
          {error && !pending && !confirmDelete && (
            <p className="od-field-error" role="alert">
              {error}
            </p>
          )}
        </DetailPanelSection>
      )}
      <DetailPanelSection title="Series">
        {series.data && series.data.items.length > 0 ? (
          <ul className="od-items">
            {series.data.items.map((item) => (
              <li key={item.id}>
                <span>
                  <b>Every {weekdayName(item.weekday)}</b>
                  <small>
                    {slotSummary(item.timeslots.map((slot) => ({ start: slot.startTime, end: slot.endTime })))} ·{' '}
                    {plural(item.dayCount, 'open day')}
                  </small>
                </span>
                {editable && (
                  <Button kind="ghost" size="sm" as={Link} to={`/open-days/${period.id}?series=${item.id}`}>
                    Edit
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="od-hint">{series.isPending ? 'Loading…' : 'No series. Add open days from the schedule.'}</p>
        )}
      </DetailPanelSection>
      <DetailPanelSection title="Holidays and breaks">
        {context.data && context.data.entries.length > 0 ? (
          <ul className="od-items">
            {context.data.entries.map((entry) => (
              <li key={`${entry.name}-${entry.startsOn}`}>
                <span>
                  <b>{entry.name}</b>
                  <small>
                    {entry.startsOn === entry.endsOn
                      ? shortDate(entry.startsOn)
                      : `${dayMonth(entry.startsOn)} – ${dayMonth(entry.endsOn)}`}
                  </small>
                </span>
                <Tag type="warm-gray" size="sm">
                  {entry.category === 'publicHoliday' ? 'Holiday' : 'Break'}
                </Tag>
              </li>
            ))}
          </ul>
        ) : (
          <p className="od-hint">{context.isPending ? 'Loading…' : 'None in this period.'}</p>
        )}
      </DetailPanelSection>
      <DestructiveActionDialog
        open={pending !== null}
        title={`${pending?.label ?? ''}?`}
        fate="none"
        confirmLabel={pending?.label ?? 'Confirm'}
        pending={transition.isPending}
        error={error}
        onClose={() => setPending(null)}
        onConfirm={() => pending && transition.mutate(pending)}
      >
        <p>
          <b>{period.name}</b>
        </p>
        <p>{pending?.effect}</p>
      </DestructiveActionDialog>
      <DestructiveActionDialog
        open={confirmDelete}
        title="Delete period?"
        fate="permanent"
        confirmLabel="Delete period"
        pending={remove.isPending}
        error={error}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate()}
      >
        <p>
          <b>{period.name}</b> with {plural(period.totalOpenDays, 'open day')}, their sign-ups and series is deleted.
          The audit log keeps that it happened.
        </p>
      </DestructiveActionDialog>
    </DetailPanel>
  );
}
