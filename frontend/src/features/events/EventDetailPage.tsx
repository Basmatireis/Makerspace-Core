import './styles.scss';
import { Calendar, Edit, Launch, Location, TrashCan, User } from '@carbon/icons-react';
import { Button, Tab, TabList, TabPanel, TabPanels, Tabs, Tag } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { deleteEvent } from '../../api/generated/events/events';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { PageShell } from '../../app/PageShell';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { eventMutationMessage } from './errors';
import { EventFilesPanel } from './EventFilesPanel';
import { EventOverviewPanel } from './EventOverviewPanel';
import { EventPlanningPanel } from './EventPlanningPanel';
import { EventSchedulePanel } from './EventSchedulePanel';
import { EventSettingsPanel } from './EventSettingsPanel';
import { EventStaffingPanel } from './EventStaffingPanel';
import { eventRange, statusTagType } from './format';
import { eventKeys, eventQueryOptions } from './queries';

const tabs = ['overview', 'schedule', 'planning', 'staffing', 'files', 'settings'] as const;
type EventTab = typeof tabs[number];
const tabLabels: Record<EventTab, string> = {
  overview: 'Overview', schedule: 'Schedule', planning: 'Planning', staffing: 'Staffing', files: 'Files', settings: 'Settings',
};

function isEventTab(value: string | null): value is EventTab {
  return tabs.includes(value as EventTab);
}

export function EventDetailPage() {
  const { eventId = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const currentUser = useCurrentUser();
  const queryClient = useQueryClient();
  const query = useQuery(eventQueryOptions(eventId));
  const canManage = hasPermission(currentUser, PermissionId.eventsmanage);
  const canStaff = hasPermission(currentUser, PermissionId.eventsstaffingmanage);
  const canAssign = hasPermission(currentUser, PermissionId.eventsassign);
  const selectedTab: EventTab = isEventTab(searchParams.get('tab')) ? searchParams.get('tab') as EventTab : 'overview';
  const selectedIndex = tabs.indexOf(selectedTab);
  const remove = useMutation({
    mutationFn: (version: number) => deleteEvent(eventId, { expectedVersion: version }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: eventKeys.all });
      navigate('/events', { replace: true });
    },
  });
  const [deleteOpen, setDeleteOpen] = useState(false);

  const selectTab = (tab: EventTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    navigate({ search: `?${next.toString()}` });
  };

  if (query.isPending) return <PageShell title="Event"><InlineLoadingState label="Loading event"/></PageShell>;
  if (query.isError) return <PageShell title="Event"><ErrorState title="Unable to load event" message="It may not exist or you may no longer have access." onRetry={() => void query.refetch()}/></PageShell>;

  const event = query.data;
  const archived = event.status === 'archived';
  const scheduleReadOnly = archived || event.status === 'completed' || event.status === 'cancelled';

  return <Tabs selectedIndex={selectedIndex} onChange={({ selectedIndex: nextIndex }) => selectTab(tabs[nextIndex] ?? 'overview')}>
    <PageShell
      title={event.name}
      titleAdornment={<><Tag type={statusTagType(event.status)}>{event.status}</Tag>{event.isPublic && <Tag type="purple">published</Tag>}</>}
      breadcrumbs={[{ label: 'Events', to: '/events' }, { label: event.name }]}
      actions={<div className="button-cluster">{event.isPublic && <Button kind="tertiary" renderIcon={Launch} onClick={() => navigate(`/events/public/${event.publicId}`)}>Public view</Button>}{canManage && <Button renderIcon={Edit} onClick={() => selectTab('settings')}>Edit event</Button>}{canManage && event.status === 'draft' && <Button kind="danger--tertiary" renderIcon={TrashCan} onClick={() => setDeleteOpen(true)}>Delete event</Button>}</div>}
      tabs={<TabList aria-label="Event sections" contained>{tabs.map((tab) => <Tab key={tab}>{tabLabels[tab]}</Tab>)}</TabList>}
      width="wide"
      className="event-detail-page"
    >
      <div className="event-detail-summary"><span><Calendar size={20}/>{eventRange(event)}</span><span><Location size={20}/>{event.location ?? 'Location not set'}</span><span><User size={20}/>{event.ownerName ?? 'No owner'}</span></div>
      <TabPanels>
        {tabs.map((tab) => <TabPanel key={tab} className="event-detail-tab-panel">{tab === selectedTab && (tab === 'overview'
          ? <EventOverviewPanel event={event} onOpenTab={selectTab} onOpenPublic={() => navigate(`/events/public/${event.publicId}`)} />
          : tab === 'schedule' ? <EventSchedulePanel eventId={eventId} canManage={canManage} canStaff={canStaff} archived={scheduleReadOnly}/>
            : tab === 'planning' ? <EventPlanningPanel eventId={eventId} canManage={canManage} archived={archived}/>
              : tab === 'staffing' ? <EventStaffingPanel eventId={eventId} canStaff={canStaff} canAssign={canAssign} archived={scheduleReadOnly}/>
                : tab === 'files' ? <EventFilesPanel eventId={eventId} canManage={canManage} archived={archived}/>
                  : <EventSettingsPanel event={event} canManage={canManage}/>)}</TabPanel>)}
      </TabPanels>
      <DestructiveActionDialog open={deleteOpen} title={`Delete ${event.name}?`} confirmLabel="Delete event" pending={remove.isPending} error={remove.isError ? eventMutationMessage(remove.error) : undefined} onClose={() => setDeleteOpen(false)} onConfirm={() => remove.mutate(event.version)}>
        <p>This permanently deletes the draft event and its planning data. Draft events with any current or historical staffing assignment cannot be deleted.</p>
      </DestructiveActionDialog>
    </PageShell>
  </Tabs>;
}
