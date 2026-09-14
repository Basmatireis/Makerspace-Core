import { useMemo, useState } from 'react';
import { Add, Close, Edit, Misuse, TrashCan } from '@carbon/icons-react';
import { Button, InlineNotification, Modal, Search, Stack, Tag } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { assignOpenDayPerson, cancelOpenDay, deleteOpenDay, getOpenDayCalendarContext, joinOpenDay, leaveOpenDay, listOpenDayEligiblePeople, removeOpenDayAssignment } from '../../api/generated/open-days/open-days';
import type { OpenDayPeriodStatus, OpenDayStaffRequirement } from '../../api/generated/models';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { longDate, staffingLabel, statusTagType, timeRange } from './format';
import { openDayKeys, openDayQueryOptions } from './queries';

export function OpenDayDetailPage() {
  const { periodId = '', openDayId = '' } = useParams();
  return <OpenDayDetails periodId={periodId} openDayId={openDayId} presentation="page" />;
}

export function OpenDayRegistrationModal({ periodId, periodStatus, openDayId, onRequestClose }: { periodId: string; periodStatus: OpenDayPeriodStatus; openDayId: string; onRequestClose: () => void }) {
  return <OpenDayDetails periodId={periodId} periodStatus={periodStatus} openDayId={openDayId} presentation="modal" onRequestClose={onRequestClose} />;
}

function OpenDayDetails({ periodId, periodStatus, openDayId, presentation, onRequestClose }: { periodId: string; periodStatus?: OpenDayPeriodStatus; openDayId: string; presentation: 'page' | 'modal'; onRequestClose?: () => void }) {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const dayQuery = useQuery(openDayQueryOptions(openDayId));
  const contextQuery = useQuery({ queryKey: [...openDayKeys.schedule(periodId), 'context'], queryFn: ({ signal }) => getOpenDayCalendarContext(periodId, { signal }), enabled: Boolean(periodId) });
  const [assignRequirement, setAssignRequirement] = useState<OpenDayStaffRequirement | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [search, setSearch] = useState('');
  const eligibleQuery = useQuery({ queryKey: [...openDayKeys.day(openDayId), 'eligible', assignRequirement?.id, search], queryFn: ({ signal }) => listOpenDayEligiblePeople(assignRequirement!.id, search ? { search } : undefined, { signal }), enabled: Boolean(assignRequirement) });
  const refresh = async () => Promise.all([queryClient.invalidateQueries({ queryKey: openDayKeys.day(openDayId) }), queryClient.invalidateQueries({ queryKey: openDayKeys.schedule(periodId) }), queryClient.invalidateQueries({ queryKey: openDayKeys.periods() })]);
  const joinMutation = useMutation({ mutationFn: (requirementId: string) => joinOpenDay(openDayId, { requirementId }), onSuccess: refresh });
  const leaveMutation = useMutation({ mutationFn: () => leaveOpenDay(openDayId), onSuccess: refresh });
  const assignMutation = useMutation({ mutationFn: ({ requirementId, personId }: { requirementId: string; personId: string }) => assignOpenDayPerson(openDayId, { requirementId, personId }), onSuccess: async () => { setAssignRequirement(null); setSearch(''); await refresh(); } });
  const removeMutation = useMutation({ mutationFn: (assignmentId: string) => removeOpenDayAssignment(openDayId, assignmentId), onSuccess: refresh });
  const openDayRemovalMutation = useMutation({
    mutationFn: async () => {
      const day = dayQuery.data!;
      if (periodStatus === 'draft') return deleteOpenDay(openDayId, { expectedVersion: day.version });
      return cancelOpenDay(openDayId, { expectedVersion: day.version });
    },
    onSuccess: async () => {
      setRemoveOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: openDayKeys.schedule(periodId) }),
        queryClient.invalidateQueries({ queryKey: openDayKeys.periods() }),
      ]);
      onRequestClose?.();
    },
  });
  const mutationError = joinMutation.isError || leaveMutation.isError || assignMutation.isError || removeMutation.isError;
  const canSignup = hasPermission(currentUser, PermissionId.open_dayssignup);
  const canAssign = hasPermission(currentUser, PermissionId.open_daysassign);
  const canManage = hasPermission(currentUser, PermissionId.open_daysmanage);

  const timeZone = contextQuery.data?.timeZone ?? 'UTC';
  const heading = useMemo(() => dayQuery.data ? longDate(dayQuery.data.startsAt, timeZone) : 'Open Day', [dayQuery.data, timeZone]);
  if (dayQuery.isPending) {
    const loading = <InlineLoadingState label="Loading Open Day" />;
    return presentation === 'modal'
      ? <Modal open passiveModal modalHeading="Open Day" onRequestClose={onRequestClose}>{loading}</Modal>
      : loading;
  }
  if (dayQuery.isError || !dayQuery.data) {
    const error = <ErrorState title="Unable to load this Open Day" message="It may no longer be visible, or the connection failed." onRetry={() => void dayQuery.refetch()} />;
    return presentation === 'modal'
      ? <Modal open passiveModal modalHeading="Open Day" onRequestClose={onRequestClose}>{error}</Modal>
      : error;
  }
  const day = dayQuery.data;
  const assignmentOpen = day.status === 'scheduled';
  const canEditOpenDay = canManage && periodStatus !== 'archived';
  const canRemoveOpenDay = canManage && presentation === 'modal' && periodStatus !== 'archived' && assignmentOpen;
  const removesDraft = periodStatus === 'draft';

  const detailContent = <>
    <div className="open-day-detail-status"><Tag type={statusTagType(staffingLabel(day))}>{staffingLabel(day)}</Tag>{day.internalNote && <p><strong>Internal note:</strong> {day.internalNote}</p>}</div>
    {day.myAssignment && <div className="assignment-banner"><strong>You are assigned as {day.requirements.find((item) => item.id === day.myAssignment?.requirementId)?.kind}.</strong>{canSignup && assignmentOpen && <Button kind="danger--ghost" size="sm" disabled={leaveMutation.isPending} onClick={() => leaveMutation.mutate()}>Leave Open Day</Button>}</div>}
    {mutationError && <InlineNotification kind="error" lowContrast title="Assignment change failed" subtitle="The position may be full, you may not be eligible, or sign-ups may have closed." />}
    <div className="requirements-grid">
      {day.requirements.map((requirement) => {
        const full = requirement.assignedCount >= requirement.requiredCount;
        return <section className="requirement-card" key={requirement.id} aria-labelledby={`requirement-${requirement.id}`}>
          <div className="requirement-card__heading"><h2 id={`requirement-${requirement.id}`}>{requirement.kind === 'supervisor' ? 'Supervisors' : 'Trainees'} <small>{requirement.requiredCount} required</small></h2><Tag type={full ? 'green' : 'red'}>{requirement.assignedCount}/{requirement.requiredCount}</Tag></div>
          <div className="requirement-card__people">
            {requirement.assignments?.map((assignment) => <div className="assigned-person" key={assignment.id}><span className="assigned-person__avatar" aria-hidden="true">{assignment.displayName.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span><span>{assignment.displayName}{assignment.isCurrentUser && <strong> (you)</strong>}</span>{canAssign && assignmentOpen && <Button hasIconOnly iconDescription={`Remove ${assignment.displayName}`} kind="ghost" size="sm" renderIcon={Close} onClick={() => removeMutation.mutate(assignment.id)} />}</div>)}
            {!full && !day.myAssignment && canSignup && assignmentOpen && <Button kind="ghost" renderIcon={Add} onClick={() => joinMutation.mutate(requirement.id)}>Join as {requirement.kind}</Button>}
            {!requirement.assignments && requirement.assignedCount > 0 && <p>{requirement.assignedCount} position{requirement.assignedCount === 1 ? '' : 's'} filled</p>}
            {!full && <p className="position-available">{requirement.requiredCount - requirement.assignedCount} position{requirement.requiredCount - requirement.assignedCount === 1 ? '' : 's'} available</p>}
          </div>
          {canAssign && assignmentOpen && !full && <Button kind="ghost" size="sm" renderIcon={Add} onClick={() => setAssignRequirement(requirement)}>Assign person</Button>}
        </section>;
      })}
    </div>
    <Modal open={Boolean(assignRequirement)} modalHeading={`Assign ${assignRequirement?.kind ?? 'person'}`} passiveModal onRequestClose={() => setAssignRequirement(null)}>
      <Stack gap={4}>
        <Search size="md" labelText="Search eligible people" placeholder="Search by name" value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
        {eligibleQuery.isPending && <InlineLoadingState label="Searching eligible people" />}
        {eligibleQuery.data?.items.map((person) => <Button key={person.personId} kind="ghost" disabled={assignMutation.isPending} onClick={() => assignMutation.mutate({ requirementId: assignRequirement!.id, personId: person.personId })}>{person.displayName}</Button>)}
        {eligibleQuery.data?.items.length === 0 && <p>No enabled eligible people found.</p>}
      </Stack>
    </Modal>
    {removeOpen && <Modal
      open={removeOpen}
      danger
      modalHeading={removesDraft ? 'Delete Open Day?' : 'Cancel Open Day?'}
      primaryButtonText={removesDraft ? 'Delete Open Day' : 'Cancel Open Day'}
      secondaryButtonText="Keep Open Day"
      primaryButtonDisabled={openDayRemovalMutation.isPending}
      onRequestClose={() => {
        setRemoveOpen(false);
        openDayRemovalMutation.reset();
      }}
      onRequestSubmit={() => openDayRemovalMutation.mutate()}
    >
      <Stack gap={4}>
        {openDayRemovalMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title={removesDraft ? 'Open Day was not deleted' : 'Open Day was not cancelled'} subtitle="The Open Day may have changed. Reload and try again." />}
        <p>{removesDraft ? 'This draft Open Day will be permanently removed.' : 'The Open Day will be marked as cancelled. Existing assignments and history will be kept.'}</p>
      </Stack>
    </Modal>}
  </>;

  if (presentation === 'modal') {
    return <Modal open passiveModal size="lg" modalHeading={heading} onRequestClose={onRequestClose}>
      <Stack gap={6} className="open-day-registration-modal">
        <div className="open-day-registration-modal__summary">
          <p>{timeRange(day, timeZone)}</p>
          {canEditOpenDay && <div className="open-day-registration-modal__actions">
            <Button kind="ghost" size="sm" renderIcon={Edit} onClick={() => navigate(`/open-days/${periodId}/schedule?edit=${openDayId}`)}>Edit Open Day</Button>
            {canRemoveOpenDay && <Button kind="danger--ghost" size="sm" renderIcon={removesDraft ? TrashCan : Misuse} onClick={() => setRemoveOpen(true)}>{removesDraft ? 'Delete Open Day' : 'Cancel Open Day'}</Button>}
          </div>}
        </div>
        {detailContent}
      </Stack>
    </Modal>;
  }

  return <Stack gap={6}>
    <PageHeader title={heading} breadcrumbs={[{ label: 'Open Days', to: '/open-days' }, { label: 'Period', to: `/open-days/${periodId}` }]} description={timeRange(day, timeZone)} actions={canManage ? <Button renderIcon={Edit} onClick={() => navigate(`/open-days/${periodId}/schedule?edit=${openDayId}`)}>Edit</Button> : undefined} />
    {detailContent}
  </Stack>;
}
