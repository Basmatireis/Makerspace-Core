import { ArrowRight, CheckmarkFilled, Edit } from '@carbon/icons-react';
import {
  Button,
  Link as CarbonLink,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  Tile,
} from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import type { Event } from '../../../api/generated/models';
import { FillMeter } from '../components/FillMeter';
import { SectionHeading, SummaryTiles } from '../components/Layout';
import { fmtDay, fmtRange, plural, rangeLabel } from '../format';
import { isClosed, nextSteps, type EditTab, type NextStep } from '../logic';
import { eventHelpersQueryOptions, eventSessionsQueryOptions, eventShiftsQueryOptions } from '../queries';

export type OverviewActions = {
  editDetails: () => void;
  goLive: () => void;
  confirm: () => void;
  complete: () => void;
};

export function OverviewTab({
  event,
  now,
  canManage,
  canSeeHelpers,
  setTab,
  actions,
}: {
  event: Event;
  now: number;
  canManage: boolean;
  canSeeHelpers: boolean;
  setTab: (tab: EditTab) => void;
  actions: OverviewActions;
}) {
  const sessions = useQuery(eventSessionsQueryOptions(event.id)).data?.items ?? [];
  const shifts = useQuery(eventShiftsQueryOptions(event.id)).data?.items ?? [];
  const helpers = useQuery(eventHelpersQueryOptions(event.id, canSeeHelpers)).data;
  const steps = nextSteps(event, now, helpers?.unlinkedSignups.length ?? 0);
  const startsIn = event.rangeStartsAt ? Math.ceil((Date.parse(event.rangeStartsAt) - now) / 86_400_000) : null;
  const when =
    !event.rangeStartsAt || !event.rangeEndsAt
      ? 'Not scheduled'
      : Date.parse(event.rangeEndsAt) < now
        ? 'Over'
        : Date.parse(event.rangeStartsAt) <= now
          ? 'Running now'
          : startsIn === 1
            ? 'Tomorrow'
            : `In ${startsIn} days`;
  const items = [
    ...sessions
      .filter((s) => s.status === 'scheduled')
      .map((s) => ({ id: s.id, kind: 'Session', name: s.name || 'Session', startsAt: s.startsAt, endsAt: s.endsAt })),
    ...shifts
      .filter((s) => s.status !== 'cancelled')
      .map((s) => ({ id: s.id, kind: 'Shift', name: s.name, startsAt: s.startsAt, endsAt: s.endsAt })),
  ].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const upcoming = items.filter((item) => Date.parse(item.endsAt) >= now);
  const next = (upcoming.length > 0 ? upcoming : items).slice(0, 3);
  const run = (step: NextStep) => {
    if (step.tab) setTab(step.tab);
    else if (step.action === 'edit-details') actions.editDetails();
    else if (step.action === 'go-live') actions.goLive();
    else if (step.action === 'confirm') actions.confirm();
    else if (step.action === 'complete') actions.complete();
  };

  return (
    <div className="ev-stack ev-tab">
      <SummaryTiles
        items={[
          { label: 'Starts', value: when, detail: <span className="ev-secondary">{rangeLabel(event)}</span> },
          {
            label: 'Programme',
            value: plural(sessions.length, 'session'),
            detail: <span className="ev-secondary">{plural(shifts.length, 'shift')}</span>,
          },
          {
            label: 'Places filled',
            value: event.requiredCount > 0 ? `${event.filledCount} of ${event.requiredCount}` : 'None yet',
            detail:
              event.requiredCount > 0 ? (
                <FillMeter filled={event.filledCount} required={event.requiredCount} />
              ) : (
                <span className="ev-secondary">No places yet</span>
              ),
          },
          {
            label: 'Tasks done',
            value: `${event.taskCompleted} of ${event.taskTotal}`,
            detail:
              event.tasksOverdue > 0 ? <span className="ev-overdue">{event.tasksOverdue} overdue</span> : undefined,
          },
        ]}
      />
      <Tile>
        <SectionHeading title="Next steps" summary={steps.length > 0 ? String(steps.length) : undefined} />
        {steps.length === 0 ? (
          <p className="ev-done">
            <CheckmarkFilled size={16} /> Nothing left to do right now.
          </p>
        ) : (
          <ul className="ev-steps">
            {steps.map((step) => (
              <li key={step.id}>
                <span>{step.label}</span>
                {(step.tab || canManage) && (
                  <CarbonLink
                    href="#"
                    renderIcon={ArrowRight}
                    onClick={(e: React.MouseEvent) => {
                      e.preventDefault();
                      run(step);
                    }}
                  >
                    {step.tab ? 'Go there' : 'Do it'}
                  </CarbonLink>
                )}
              </li>
            ))}
          </ul>
        )}
      </Tile>
      <div className="ev-detail-layout">
        <Tile>
          <SectionHeading
            title="Coming up"
            actions={
              <CarbonLink
                href="#"
                renderIcon={ArrowRight}
                onClick={(e: React.MouseEvent) => {
                  e.preventDefault();
                  setTab('programme');
                }}
              >
                Open programme
              </CarbonLink>
            }
          />
          {next.length === 0 ? (
            <p className="ev-secondary">
              The programme is empty. Add a session or a helper shift in the Programme tab.
            </p>
          ) : (
            <div className="ev-scroll">
              <Table size="md" aria-label="Coming up" className="ev-table">
                <TableHead>
                  <TableRow>
                    <TableHeader>Day</TableHeader>
                    <TableHeader>Time</TableHeader>
                    <TableHeader>Item</TableHeader>
                    <TableHeader>Type</TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {next.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>{fmtDay(item.startsAt)}</TableCell>
                      <TableCell className="ev-col-time">{fmtRange(item.startsAt, item.endsAt)}</TableCell>
                      <TableCell>{item.name}</TableCell>
                      <TableCell>
                        <Tag size="sm" type={item.kind === 'Session' ? 'blue' : 'cool-gray'}>
                          {item.kind}
                        </Tag>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Tile>
        <Tile>
          <SectionHeading
            title="About"
            actions={
              canManage &&
              !isClosed(event.status) && (
                <Button kind="tertiary" size="sm" renderIcon={Edit} onClick={actions.editDetails}>
                  Edit details
                </Button>
              )
            }
          />
          <dl className="ev-facts">
            <div>
              <dt>Owner</dt>
              <dd>
                {event.ownerName ?? (
                  <Tag type="red" size="sm">
                    No owner yet
                  </Tag>
                )}
              </dd>
            </div>
            <div>
              <dt>Internal location</dt>
              <dd>{event.location || <span className="ev-secondary">Not set</span>}</dd>
            </div>
            <div>
              <dt>Internal description</dt>
              <dd className="ev-pre">{event.internalDescription || <span className="ev-secondary">Not set</span>}</dd>
            </div>
          </dl>
        </Tile>
      </div>
    </div>
  );
}
