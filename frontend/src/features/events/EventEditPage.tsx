import './styles.scss';
import { Launch, Rocket, View } from '@carbon/icons-react';
import {
  Button,
  InlineNotification,
  Link as CarbonLink,
  OverflowMenu,
  OverflowMenuItem,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Tag,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  cancelEvent,
  completeEvent,
  confirmEvent,
  deleteEvent,
  returnEventToDraft,
  rotateEventPublicId,
} from '../../api/generated/events/events';
import { useNow } from '../../app/useNow';
import { PageShell } from '../../app/PageShell';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { eventAccess } from './access';
import { SummaryStrip } from './components/Layout';
import { EventStatusTag, PublicPageTag, SignupStateTag } from './components/StatusTags';
import { ConfirmDialog } from './dialogs/ConfirmDialog';
import { EditDetailsDialog } from './dialogs/EditDetailsDialog';
import { GoLivePanel } from './dialogs/GoLivePanel';
import { HelpersTab } from './edit/HelpersTab';
import { OverviewTab } from './edit/OverviewTab';
import { ProgrammeTab } from './edit/ProgrammeTab';
import { PublicPageTab } from './edit/PublicPageTab';
import { TasksTab } from './edit/TasksTab';
import { eventMutationMessage } from './errors';
import { EventFilesPanel } from './EventFilesPanel';
import { rangeLabel } from './format';
import { closedNotice, isClosed, READINESS, type EditTab, type FixTarget } from './logic';
import { eventQueryOptions, eventShiftsQueryOptions, invalidateEvents } from './queries';

const TAB_LABEL: Record<EditTab, string> = {
  overview: 'Overview',
  programme: 'Programme',
  helpers: 'Helpers',
  tasks: 'Tasks',
  public: 'Public page',
  files: 'Files',
};
const ALL_TABS: EditTab[] = ['overview', 'programme', 'helpers', 'tasks', 'public', 'files'];
type Dialog = 'edit' | 'golive' | 'rotate' | 'confirm' | 'draft' | 'complete' | 'cancel' | 'delete';
type Lifecycle = 'confirm' | 'draft' | 'complete' | 'cancel' | 'delete';

/** The edit mode (`?mode=edit`): header with lifecycle actions, then Overview, Programme, Helpers, Tasks, Public page, Files. */
export function EventEditPage() {
  const { eventId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const access = eventAccess(useCurrentUser());
  const now = useNow(30_000);
  const query = useQuery(eventQueryOptions(eventId));
  const shifts = useQuery(eventShiftsQueryOptions(eventId));
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const lifecycle = useMutation({
    mutationFn: async (kind: Lifecycle): Promise<void> => {
      const version = { expectedVersion: query.data?.version ?? 0 };
      switch (kind) {
        case 'confirm':
          await confirmEvent(eventId, version);
          return;
        case 'draft':
          await returnEventToDraft(eventId, version);
          return;
        case 'complete':
          await completeEvent(eventId, version);
          return;
        case 'cancel':
          await cancelEvent(eventId, version);
          return;
        default:
          await deleteEvent(eventId, version);
      }
    },
    onSuccess: async (_, kind) => {
      await invalidateEvents(client);
      setDialog(null);
      if (kind === 'delete') navigate('/events', { replace: true });
    },
  });
  const rotate = useMutation({
    mutationFn: () => rotateEventPublicId(eventId, { expectedVersion: query.data?.version ?? 0 }),
    onSuccess: async () => {
      await invalidateEvents(client);
      setDialog('golive');
    },
  });

  const tabs = ALL_TABS.filter((tab) =>
    tab === 'overview'
      ? true
      : tab === 'programme'
        ? access.canEdit
        : tab === 'helpers'
          ? access.canEdit || access.assign
          : access.manage,
  );
  const requested = params.get('tab') as EditTab | null;
  const tab: EditTab = requested && tabs.includes(requested) ? requested : 'overview';
  const setTab = (next: EditTab) =>
    setParams(next === 'overview' ? { mode: 'edit' } : { mode: 'edit', tab: next }, { replace: true });

  const crumbs = [{ label: 'Events', to: '/events' }];
  if (query.isPending)
    return (
      <PageShell title="Event" breadcrumbs={crumbs} width="wide">
        <InlineLoadingState label="Loading event" />
      </PageShell>
    );
  if (query.isError)
    return (
      <PageShell title="Event" breadcrumbs={crumbs} width="wide">
        <ErrorState
          title="Unable to load event"
          message="It may not exist or you may no longer have access."
          onRetry={() => void query.refetch()}
        />
      </PageShell>
    );
  const event = query.data;
  if (!access.organizer) return <Navigate to={`/events/${eventId}`} replace />;

  const closed = isClosed(event.status);
  const live = event.goLive.publicPage.state === 'live';
  const ended = Boolean(event.rangeEndsAt) && Date.parse(event.rangeEndsAt!) <= now;
  const close = () => {
    lifecycle.reset();
    setDialog(null);
  };
  const run = (kind: Lifecycle) => lifecycle.mutate(kind);
  const fix = (target: FixTarget) => {
    if (target === 'details') setDialog('edit');
    else if (target === 'confirm') setDialog('confirm');
    else if (target === 'programme' || target === 'public') {
      setDialog(null);
      setTab(target);
    }
  };
  const failure = lifecycle.isError ? eventMutationMessage(lifecycle.error) : undefined;
  const missing = event.goLive.confirmUnmet.map((code) => READINESS[code].text);
  const deleteBlocked =
    event.status !== 'draft'
      ? 'Only a draft can be deleted. Cancel the event to close it instead.'
      : event.hasAssignmentHistory
        ? 'This event has assignment history (including cancelled signups). Cancel it instead; history is kept for the audit trail.'
        : undefined;

  const primary =
    access.manage && !closed ? (
      event.status === 'draft' ? (
        <Button onClick={() => setDialog('confirm')}>Confirm event</Button>
      ) : ended ? (
        <Button onClick={() => setDialog('complete')}>Mark completed</Button>
      ) : undefined
    ) : undefined;
  const actions = (
    <>
      <Button kind="tertiary" renderIcon={View} as={Link} to={`/events/${event.id}`}>
        View as helper
      </Button>
      {access.manage && (!closed || live) && (
        <Button kind="tertiary" renderIcon={Rocket} onClick={() => setDialog('golive')}>
          {live ? 'Public link & signup' : 'Go live'}
        </Button>
      )}
      {primary}
      {access.manage && (
        <div>
          <OverflowMenu flipped aria-label="Event actions" iconDescription="Event actions">
            {!closed && <OverflowMenuItem itemText="Edit details" onClick={() => setDialog('edit')} />}
            {event.status === 'confirmed' && !ended && (
              <OverflowMenuItem itemText="Mark completed" onClick={() => setDialog('complete')} />
            )}
            {event.status === 'confirmed' && (
              <OverflowMenuItem itemText="Back to draft" onClick={() => setDialog('draft')} />
            )}
            {!closed && (
              <OverflowMenuItem itemText="Cancel event" isDelete hasDivider onClick={() => setDialog('cancel')} />
            )}
            <OverflowMenuItem
              itemText="Delete event"
              isDelete
              hasDivider={closed}
              onClick={() => setDialog('delete')}
            />
          </OverflowMenu>
        </div>
      )}
    </>
  );

  return (
    <PageShell
      title={event.name}
      width="wide"
      className="event-detail-page"
      breadcrumbs={crumbs}
      actions={actions}
      titleAdornment={<EventStatusTag status={event.status} />}
    >
      <div className="ev-stack">
        <SummaryStrip
          label="Event summary"
          items={[
            { label: 'Date', value: rangeLabel(event) },
            { label: 'Location', value: event.location || <span className="ev-secondary">Not set</span> },
            {
              label: 'Owner',
              value: event.ownerName ?? (
                <Tag type="red" size="sm">
                  No owner yet
                </Tag>
              ),
            },
            {
              label: 'Public page',
              value: (
                <span className="ev-inline">
                  <PublicPageTag event={event} />
                  {live && (
                    <CarbonLink as={Link} to={`/events/public/${event.publicId}`} renderIcon={Launch}>
                      View public page
                    </CarbonLink>
                  )}
                </span>
              ),
            },
            { label: 'Helper signup', value: <SignupStateTag event={event} /> },
          ]}
        />
        {closed && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title={`This event is ${event.status}`}
            subtitle={`${closedNotice(event.status)} Helper names and contact details are erased automatically some time after the event closed.${live ? ' The public page is still live; switch it off under "Public link & signup".' : ''}`}
          />
        )}
        <Tabs selectedIndex={tabs.indexOf(tab)} onChange={({ selectedIndex }) => setTab(tabs[selectedIndex])}>
          <TabList aria-label="Event sections" contained>
            {tabs.map((item) => (
              <Tab key={item}>{TAB_LABEL[item]}</Tab>
            ))}
          </TabList>
          <TabPanels>
            {tabs.map((item) => (
              <TabPanel key={item}>
                {tab === item && item === 'overview' && (
                  <OverviewTab
                    event={event}
                    now={now}
                    canManage={access.manage}
                    canSeeHelpers={access.staffing || access.assign}
                    setTab={setTab}
                    actions={{
                      editDetails: () => setDialog('edit'),
                      goLive: () => setDialog('golive'),
                      confirm: () => setDialog('confirm'),
                      complete: () => setDialog('complete'),
                    }}
                  />
                )}
                {tab === item && item === 'programme' && (
                  <ProgrammeTab event={event} canSessions={access.manage} canShifts={access.staffing} />
                )}
                {tab === item && item === 'helpers' && (
                  <HelpersTab
                    event={event}
                    canAssign={access.assign}
                    canSeeNames={access.canSeeNames}
                    canSeeContacts={access.canSeeContacts}
                  />
                )}
                {tab === item && item === 'tasks' && <TasksTab event={event} now={now} canManage={access.manage} />}
                {tab === item && item === 'public' && (
                  <PublicPageTab event={event} now={now} canManage={access.manage} />
                )}
                {tab === item && item === 'files' && (
                  <div className="ev-tab">
                    <EventFilesPanel eventId={event.id} canManage={access.manage} archived={false} />
                  </div>
                )}
              </TabPanel>
            ))}
          </TabPanels>
        </Tabs>
      </div>

      {dialog === 'edit' && <EditDetailsDialog event={event} onClose={close} />}
      {dialog === 'golive' && (
        <GoLivePanel
          event={event}
          shifts={shifts.data?.items ?? []}
          onClose={close}
          onFix={fix}
          onRotate={() => setDialog('rotate')}
        />
      )}
      {dialog === 'rotate' && (
        <ConfirmDialog
          heading="Rotate public link"
          label={event.name}
          confirmText="Rotate link"
          danger
          pending={rotate.isPending}
          error={rotate.isError ? eventMutationMessage(rotate.error) : undefined}
          onClose={() => setDialog('golive')}
          onConfirm={() => rotate.mutate()}
        >
          <p>
            The current public link and every QR code or flyer that uses it stop working immediately. Visitors who open
            the old link see &ldquo;not available&rdquo;. Existing signups and their management links are not affected.
          </p>
        </ConfirmDialog>
      )}
      {dialog === 'confirm' && (
        <ConfirmDialog
          heading="Confirm event"
          label={event.name}
          confirmText="Confirm event"
          pending={lifecycle.isPending}
          error={failure}
          blocked={missing.length > 0 ? `Before confirming: ${missing.join(' and ').toLowerCase()}.` : undefined}
          onClose={close}
          onConfirm={() => run('confirm')}
        >
          <p>
            A confirmed event is planned for sure and opens in-app signup for helpers. You can still change everything
            and move it back to draft.
          </p>
        </ConfirmDialog>
      )}
      {dialog === 'draft' && (
        <ConfirmDialog
          heading="Back to draft"
          label={event.name}
          confirmText="Move to draft"
          pending={lifecycle.isPending}
          error={failure}
          onClose={close}
          onConfirm={() => run('draft')}
        >
          <p>
            The event goes back to being planned and disappears for helpers. The public page keeps its state until you
            switch it off.
          </p>
        </ConfirmDialog>
      )}
      {dialog === 'complete' && (
        <ConfirmDialog
          heading="Mark as completed"
          label={event.name}
          confirmText="Mark completed"
          pending={lifecycle.isPending}
          error={failure}
          onClose={close}
          onConfirm={() => run('complete')}
        >
          <p>
            Details, programme and helpers become read-only and helper signup closes. Tasks and files stay editable for
            post-event work. The public page stays live until you switch it off.
          </p>
        </ConfirmDialog>
      )}
      {dialog === 'cancel' && (
        <ConfirmDialog
          heading="Cancel event"
          label={event.name}
          confirmText="Cancel event"
          danger
          pending={lifecycle.isPending}
          error={failure}
          onClose={close}
          onConfirm={() => run('cancel')}
        >
          <p>
            The event becomes read-only and helper signup closes. This cannot be undone. Tasks and files stay editable.
          </p>
        </ConfirmDialog>
      )}
      {dialog === 'delete' && (
        <ConfirmDialog
          heading="Delete event"
          label={event.name}
          confirmText="Delete event"
          danger
          blocked={deleteBlocked}
          pending={lifecycle.isPending}
          error={failure}
          onClose={close}
          onConfirm={() => run('delete')}
        >
          <p>
            The event, its planning data and its files are deleted permanently. Only a draft that never had an
            assignment can be deleted.
          </p>
        </ConfirmDialog>
      )}
    </PageShell>
  );
}
