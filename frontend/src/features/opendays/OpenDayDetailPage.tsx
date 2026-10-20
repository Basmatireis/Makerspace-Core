import './styles.scss';
import { useLatestCallback } from '../../app/useLatestCallback';
import { useState } from 'react';
import { Add, Close, Edit, Misuse, TrashCan } from '@carbon/icons-react';
import { Button, InlineNotification, Modal, Search, Stack, Tag, Tile } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  assignOpenDayPerson,
  cancelOpenDay,
  deleteOpenDay,
  getOpenDayCalendarContext,
  joinOpenDay,
  leaveOpenDay,
  listOpenDayEligiblePeople,
  removeOpenDayAssignment,
} from '../../api/generated/open-days/open-days';
import type { OpenDayAssignment, OpenDayPeriodStatus, OpenDayStaffRequirement } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { longDate, staffingLabel, statusTagType, timeRange } from './format';
import { openDaySchedulePath } from './paths';
import { openDayKeys, openDayQueryOptions, scheduleQueryOptions } from './queries';

export function OpenDayDetailPage() {
  const { periodId = '', openDayId = '' } = useParams();
  return <OpenDayDetails periodId={periodId} openDayId={openDayId} presentation="page" />;
}

export function OpenDayRegistrationModal({
  periodId,
  periodStatus,
  openDayId,
  onRequestClose,
}: {
  periodId: string;
  periodStatus: OpenDayPeriodStatus;
  openDayId: string;
  onRequestClose: () => void;
}) {
  return (
    <OpenDayDetails
      periodId={periodId}
      periodStatus={periodStatus}
      openDayId={openDayId}
      presentation="modal"
      onRequestClose={onRequestClose}
    />
  );
}

function OpenDayDetails({
  periodId,
  periodStatus,
  openDayId,
  presentation,
  onRequestClose,
}: {
  periodId: string;
  periodStatus?: OpenDayPeriodStatus;
  openDayId: string;
  presentation: 'page' | 'modal';
  onRequestClose?: () => void;
}) {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canSignup = hasPermission(currentUser, PermissionId.open_dayssignup);
  const canAssign = hasPermission(currentUser, PermissionId.open_daysassign);
  const canManage = hasPermission(currentUser, PermissionId.open_daysmanage);
  const scheduleQuery = useQuery({ ...scheduleQueryOptions(periodId), enabled: canManage && presentation === 'page' });
  const effectivePeriodStatus = periodStatus ?? scheduleQuery.data?.period.status;
  const dayQuery = useQuery(openDayQueryOptions(openDayId));
  const contextQuery = useQuery({
    queryKey: [...openDayKeys.schedule(periodId), 'context'],
    queryFn: ({ signal }) => getOpenDayCalendarContext(periodId, { signal }),
    enabled: Boolean(periodId),
  });
  const [assignRequirement, setAssignRequirement] = useState<OpenDayStaffRequirement | null>(null);
  const [assignmentRemoval, setAssignmentRemoval] = useState<OpenDayAssignment | 'self' | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [search, setSearch] = useState('');
  const eligibleQuery = useQuery({
    queryKey: [...openDayKeys.day(openDayId), 'eligible', assignRequirement?.id, search],
    queryFn: ({ signal }) =>
      listOpenDayEligiblePeople(assignRequirement!.id, search ? { search } : undefined, { signal }),
    enabled: canAssign && Boolean(assignRequirement),
  });
  const refresh = async () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: openDayKeys.day(openDayId) }),
      queryClient.invalidateQueries({ queryKey: openDayKeys.schedule(periodId) }),
      queryClient.invalidateQueries({ queryKey: openDayKeys.periods() }),
    ]);
  const joinMutation = useMutation({
    mutationFn: (requirementId: string) => joinOpenDay(openDayId, { requirementId }),
    onSuccess: refresh,
  });
  const leaveMutation = useMutation({
    mutationFn: () => leaveOpenDay(openDayId),
    onSuccess: async () => {
      setAssignmentRemoval(null);
      await refresh();
    },
  });
  const assignMutation = useMutation({
    mutationFn: ({ requirementId, personId }: { requirementId: string; personId: string }) =>
      assignOpenDayPerson(openDayId, { requirementId, personId }),
    onSuccess: async () => {
      setAssignRequirement(null);
      setSearch('');
      await refresh();
    },
  });
  const removeMutation = useMutation({
    mutationFn: (assignmentId: string) => removeOpenDayAssignment(openDayId, assignmentId),
    onSuccess: async () => {
      setAssignmentRemoval(null);
      await refresh();
    },
  });
  const openDayRemovalMutation = useMutation({
    mutationFn: async () => {
      const day = dayQuery.data!;
      if (effectivePeriodStatus === 'draft') return deleteOpenDay(openDayId, { expectedVersion: day.version });
      return cancelOpenDay(openDayId, { expectedVersion: day.version });
    },
    onSuccess: async () => {
      setRemoveOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: openDayKeys.schedule(periodId) }),
        queryClient.invalidateQueries({ queryKey: openDayKeys.periods() }),
      ]);
      if (presentation === 'page') navigate(`/open-days/${periodId}`);
      else onRequestClose?.();
    },
  });
  const mutationError =
    joinMutation.isError || leaveMutation.isError || assignMutation.isError || removeMutation.isError;
  const mutationPending =
    joinMutation.isPending ||
    leaveMutation.isPending ||
    assignMutation.isPending ||
    removeMutation.isPending ||
    openDayRemovalMutation.isPending;
  const backToDetails = useLatestCallback(() => {
    if (mutationPending) return;
    setAssignRequirement(null);
    setAssignmentRemoval(null);
    setRemoveOpen(false);
    setSearch('');
    assignMutation.reset();
    leaveMutation.reset();
    removeMutation.reset();
    openDayRemovalMutation.reset();
  });
  const requestModalClose = useLatestCallback(() => {
    if (mutationPending) return;
    if (assignRequirement || removeOpen || assignmentRemoval) backToDetails();
    else onRequestClose?.();
  });
  const timeZone = contextQuery.data?.timeZone ?? 'UTC';
  const heading = dayQuery.data ? longDate(dayQuery.data.startsAt, timeZone) : 'Open Day';
  if (dayQuery.isPending) {
    const loading = <InlineLoadingState label="Loading Open Day" />;
    return presentation === 'modal' ? (
      <Modal open passiveModal modalHeading="Open Day" onRequestClose={onRequestClose}>
        {loading}
      </Modal>
    ) : (
      loading
    );
  }
  if (dayQuery.isError || !dayQuery.data) {
    const error = (
      <ErrorState
        title="Unable to load this Open Day"
        message="It may no longer be visible, or the connection failed."
        onRetry={() => void dayQuery.refetch()}
      />
    );
    return presentation === 'modal' ? (
      <Modal open passiveModal modalHeading="Open Day" onRequestClose={onRequestClose}>
        {error}
      </Modal>
    ) : (
      error
    );
  }
  const day = dayQuery.data;
  const assignmentOpen = day.status === 'scheduled' && effectivePeriodStatus !== 'archived';
  const canEditOpenDay = canManage && effectivePeriodStatus !== undefined && effectivePeriodStatus !== 'archived';
  const canRemoveOpenDay = canEditOpenDay && assignmentOpen;
  const removesDraft = effectivePeriodStatus === 'draft';

  const detailContent = (
    <>
      <div className="open-day-detail-status">
        <Tag type={statusTagType(staffingLabel(day))}>{staffingLabel(day)}</Tag>
        {day.internalNote && (
          <p>
            <strong>Internal note:</strong> {day.internalNote}
          </p>
        )}
      </div>
      {day.myAssignment && (
        <div className="assignment-banner">
          <strong>
            You are assigned as {day.requirements.find((item) => item.id === day.myAssignment?.requirementId)?.kind}.
          </strong>
          {canSignup && assignmentOpen && (
            <Button
              kind="danger--ghost"
              size="sm"
              disabled={leaveMutation.isPending}
              onClick={() => setAssignmentRemoval('self')}
            >
              Leave Open Day
            </Button>
          )}
        </div>
      )}
      {mutationError && (
        <InlineNotification
          kind="error"
          lowContrast
          title="Assignment change failed"
          subtitle="The position may be full, you may not be eligible, or sign-ups may have closed."
        />
      )}
      <div className="requirements-grid">
        {day.requirements.map((requirement) => {
          const full = requirement.assignedCount >= requirement.requiredCount;
          return (
            <Tile className="requirement-card" key={requirement.id} aria-labelledby={`requirement-${requirement.id}`}>
              <div className="requirement-card__heading">
                <h2 id={`requirement-${requirement.id}`}>
                  {requirement.kind === 'supervisor' ? 'Supervisors' : 'Trainees'}{' '}
                  <small>{requirement.requiredCount} required</small>
                </h2>
                <Tag type={full ? 'green' : 'red'}>
                  {requirement.assignedCount}/{requirement.requiredCount}
                </Tag>
              </div>
              <div className="requirement-card__people">
                {requirement.assignments?.map((assignment) => (
                  <div className="assigned-person" key={assignment.id}>
                    <span className="assigned-person__avatar" aria-hidden="true">
                      {assignment.displayName
                        .split(' ')
                        .map((part) => part[0])
                        .slice(0, 2)
                        .join('')}
                    </span>
                    <span>
                      {assignment.displayName}
                      {assignment.isCurrentUser && <strong> (you)</strong>}
                    </span>
                    {canAssign && assignmentOpen && (
                      <Button
                        hasIconOnly
                        iconDescription={`Remove ${assignment.displayName}`}
                        kind="ghost"
                        size="sm"
                        renderIcon={Close}
                        disabled={mutationPending}
                        onClick={() => setAssignmentRemoval(assignment)}
                      />
                    )}
                  </div>
                ))}
                {!full && !day.myAssignment && canSignup && assignmentOpen && (
                  <Button
                    kind="ghost"
                    renderIcon={Add}
                    disabled={mutationPending}
                    onClick={() => joinMutation.mutate(requirement.id)}
                  >
                    Join as {requirement.kind}
                  </Button>
                )}
                {!requirement.assignments && requirement.assignedCount > 0 && (
                  <p>
                    {requirement.assignedCount} position{requirement.assignedCount === 1 ? '' : 's'} filled
                  </p>
                )}
                {!full && (
                  <p className="position-available">
                    {requirement.requiredCount - requirement.assignedCount} position
                    {requirement.requiredCount - requirement.assignedCount === 1 ? '' : 's'} available
                  </p>
                )}
              </div>
              {canAssign && assignmentOpen && !full && (
                <Button
                  kind="ghost"
                  size="sm"
                  renderIcon={Add}
                  disabled={mutationPending}
                  onClick={() => {
                    assignMutation.reset();
                    setAssignRequirement(requirement);
                  }}
                >
                  Assign person
                </Button>
              )}
            </Tile>
          );
        })}
      </div>
    </>
  );

  const confirmAssignmentRemoval = () => {
    if (mutationPending) return;
    if (assignmentRemoval === 'self') leaveMutation.mutate();
    else if (assignmentRemoval) removeMutation.mutate(assignmentRemoval.id);
  };
  const assignmentRemovalText =
    assignmentRemoval === 'self'
      ? 'Your place will become available to another eligible person.'
      : `${assignmentRemoval?.displayName ?? 'This person'} will be removed from this Open Day. The place will become available again.`;
  const removalText = removesDraft
    ? 'This draft Open Day and its requirements will be permanently removed. This cannot be undone.'
    : 'The Open Day will be marked as cancelled. Existing assignments and history will be kept.';
  const assignContent = (
    <Stack gap={4}>
      <Search
        size="md"
        labelText="Search eligible people"
        placeholder="Search by name"
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
      />
      {eligibleQuery.isPending && <InlineLoadingState label="Searching eligible people" />}
      {eligibleQuery.isError && (
        <ErrorState
          title="Unable to load eligible people"
          message="Check the connection and try again."
          onRetry={() => void eligibleQuery.refetch()}
        />
      )}
      {assignMutation.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Assignment failed"
          subtitle="The person may no longer be eligible or the position may be full. Your search is kept; choose another person or try again."
        />
      )}
      {eligibleQuery.data?.items.map((person) => (
        <Button
          key={person.personId}
          kind="ghost"
          disabled={mutationPending}
          onClick={() =>
            assignRequirement &&
            assignMutation.mutate({ requirementId: assignRequirement.id, personId: person.personId })
          }
        >
          {person.displayName}
        </Button>
      ))}
      {eligibleQuery.data?.items.length === 0 && <p>No enabled eligible people found.</p>}
    </Stack>
  );
  const managementActions = canEditOpenDay && (
    <div className="open-day-registration-modal__actions">
      <Button
        kind="ghost"
        size="sm"
        renderIcon={Edit}
        onClick={() => navigate(openDaySchedulePath(periodId, { editOpenDayId: openDayId }))}
      >
        Edit Open Day
      </Button>
      {canRemoveOpenDay && (
        <Button
          kind="danger--ghost"
          size="sm"
          renderIcon={removesDraft ? TrashCan : Misuse}
          onClick={() => setRemoveOpen(true)}
        >
          {removesDraft ? 'Delete Open Day' : 'Cancel Open Day'}
        </Button>
      )}
    </div>
  );

  // A single Carbon dialog changes content between detail, assignment and confirmation.
  if (presentation === 'modal') {
    const confirming = removeOpen || Boolean(assignmentRemoval);
    const dialogTitle = assignRequirement
      ? `Assign ${assignRequirement.kind}`
      : removeOpen
        ? removesDraft
          ? 'Delete Open Day?'
          : 'Cancel Open Day?'
        : assignmentRemoval
          ? assignmentRemoval === 'self'
            ? 'Leave Open Day?'
            : 'Remove assignment?'
          : heading;
    return (
      <Modal
        open
        size="lg"
        passiveModal={!confirming && !assignRequirement}
        danger={confirming}
        modalHeading={dialogTitle}
        selectorPrimaryFocus={
          confirming ? '.cds--btn--secondary' : assignRequirement ? 'input[type=search]' : '.cds--modal-close'
        }
        primaryButtonText={
          assignRequirement
            ? 'Back to Open Day'
            : removeOpen
              ? removesDraft
                ? 'Delete Open Day'
                : 'Cancel Open Day'
              : assignmentRemoval === 'self'
                ? 'Leave Open Day'
                : 'Remove assignment'
        }
        secondaryButtonText={removeOpen ? 'Keep Open Day' : confirming ? 'Keep assignment' : undefined}
        primaryButtonDisabled={mutationPending}
        onRequestClose={requestModalClose}
        onRequestSubmit={() => {
          if (mutationPending) return;
          if (assignRequirement) backToDetails();
          else if (removeOpen) openDayRemovalMutation.mutate();
          else confirmAssignmentRemoval();
        }}
      >
        {assignRequirement ? (
          assignContent
        ) : confirming ? (
          <Stack gap={4}>
            {(openDayRemovalMutation.isError || removeMutation.isError || leaveMutation.isError) && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Change failed"
                subtitle="The Open Day may have changed. Try again or return to the details."
              />
            )}
            <p>{removeOpen ? removalText : assignmentRemovalText}</p>
          </Stack>
        ) : (
          <Stack gap={6} className="open-day-registration-modal">
            <div className="open-day-registration-modal__summary">
              <p>{timeRange(day, timeZone)}</p>
              {managementActions}
            </div>
            {detailContent}
          </Stack>
        )}
      </Modal>
    );
  }

  return (
    <PageShell
      title={heading}
      breadcrumbs={[
        { label: 'Open Days', to: '/open-days' },
        { label: 'Period', to: `/open-days/${periodId}` },
      ]}
      description={timeRange(day, timeZone)}
      actions={managementActions}
    >
      {canManage && scheduleQuery.isError && (
        <ErrorState
          title="Period status unavailable"
          message="Management actions need the current period status."
          onRetry={() => void scheduleQuery.refetch()}
        />
      )}
      {detailContent}
      {assignRequirement && (
        <Modal
          open
          modalHeading={`Assign ${assignRequirement.kind}`}
          primaryButtonText="Back to Open Day"
          primaryButtonDisabled={mutationPending}
          onRequestSubmit={backToDetails}
          onRequestClose={backToDetails}
        >
          {assignContent}
        </Modal>
      )}
      {assignmentRemoval && (
        <DestructiveActionDialog
          open
          title={assignmentRemoval === 'self' ? 'Leave Open Day?' : 'Remove assignment?'}
          confirmLabel={assignmentRemoval === 'self' ? 'Leave Open Day' : 'Remove assignment'}
          pending={mutationPending}
          error={
            leaveMutation.isError || removeMutation.isError ? 'The assignment may have changed. Try again.' : undefined
          }
          onClose={backToDetails}
          onConfirm={confirmAssignmentRemoval}
        >
          <p>{assignmentRemovalText}</p>
        </DestructiveActionDialog>
      )}
      {removeOpen && (
        <DestructiveActionDialog
          open
          title={removesDraft ? 'Delete Open Day?' : 'Cancel Open Day?'}
          confirmLabel={removesDraft ? 'Delete Open Day' : 'Cancel Open Day'}
          cancelLabel="Keep Open Day"
          pending={mutationPending}
          error={openDayRemovalMutation.isError ? 'The Open Day may have changed. Try again.' : undefined}
          onClose={backToDetails}
          onConfirm={() => openDayRemovalMutation.mutate()}
        >
          <p>{removalText}</p>
        </DestructiveActionDialog>
      )}
    </PageShell>
  );
}
