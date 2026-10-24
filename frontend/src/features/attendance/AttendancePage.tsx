import { Button, InlineNotification, Stack } from '@carbon/react';
import { UserFollow } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { cancelAttendanceHold, supervisedVisitCheckOut } from '../../api/generated/attendance/attendance';
import type { AttendanceHold, Visit } from '../../api/generated/models';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { PageShell } from '../../app/PageShell';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { CurrentlyHere } from './components/CurrentlyHere';
import { LabRulesNotice } from './components/LabRulesNotice';
import { StatTile } from './components/StatTiles';
import { CheckInDialog } from './dialogs/CheckInDialog';
import { VoidVisitDialog } from './dialogs/VoidVisitDialog';
import { type ConfirmSubject, subjectFromRequest } from './presentation';
import { attendanceKeys, holdsOptions, labRulesQueueOptions, statisticsOptions, visitsOptions } from './queries';
import './attendance.scss';

type DialogState = { hold: AttendanceHold | null; subject?: ConfirmSubject } | null;

export function AttendancePage() {
  const user = useCurrentUser();
  const queryClient = useQueryClient();
  const canRead = hasPermission(user, PermissionId.attendanceread);
  const canAssist = hasPermission(user, PermissionId.attendanceassist);
  const canCorrect = hasPermission(user, PermissionId.attendancecorrect);
  const canStats = hasPermission(user, PermissionId.attendancestatisticsread);
  const canConfirm = hasPermission(user, PermissionId.laborordnungconfirm);
  const canReadQueue = hasPermission(user, PermissionId.laborordnungrequestsread);
  const canSearchPeople = hasPermission(user, PermissionId.peoplereadall);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [visitToVoid, setVisitToVoid] = useState<Visit | null>(null);
  const [waitingNotice, setWaitingNotice] = useState<AttendanceHold | null>(null);
  const visits = useQuery(visitsOptions(canRead));
  const holds = useQuery(holdsOptions(canRead));
  const queue = useQuery(labRulesQueueOptions(canReadQueue));
  const stats = useQuery(statisticsOptions(canStats));
  const refresh = () => queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
  const checkOut = useMutation({ mutationFn: (id: string) => supervisedVisitCheckOut(id), onSuccess: refresh });
  const cancelHold = useMutation({ mutationFn: (id: string) => cancelAttendanceHold(id), onSuccess: refresh });

  const heldItems = holds.data?.items ?? [];
  const hereCount = canRead ? visits.data?.items.length : stats.data?.currentOccupancy;
  const excludedPersonIds = new Set([
    ...(visits.data?.items ?? []).map((visit) => visit.personId),
    ...heldItems.map((hold) => hold.personId),
  ]);
  const showTiles = hereCount !== undefined || (canRead && holds.data) || (canStats && stats.data);

  return (
    <PageShell
      title="Attendance"
      description="Who is in the Makerspace right now, and who is waiting to be let in."
      width="wide"
      actions={
        canAssist && canSearchPeople ? (
          <Button renderIcon={UserFollow} onClick={() => setDialog({ hold: null })}>
            Check someone in
          </Button>
        ) : undefined
      }
    >
      <Stack gap={7}>
        {waitingNotice && (
          <InlineNotification
            kind="info"
            lowContrast
            title="Check-in is waiting"
            subtitle={`${waitingNotice.displayName} is waiting at the entrance until someone allowed to confirm the Lab Rules has seen their signature.`}
            onCloseButtonClick={() => setWaitingNotice(null)}
          />
        )}
        <LabRulesNotice
          holds={heldItems}
          requests={queue.data?.items ?? []}
          canCancel={canAssist}
          canConfirm={canConfirm}
          busy={cancelHold.isPending}
          onConfirmHold={(hold) => setDialog({ hold })}
          onCancelHold={(hold) => cancelHold.mutate(hold.id)}
          onConfirmRequest={(request) => setDialog({ hold: null, subject: subjectFromRequest(request) })}
        />
        {showTiles && (
          <div className="attendance-stats">
            {hereCount !== undefined && <StatTile value={hereCount} label="Currently here" />}
            {canRead && holds.data && (
              <StatTile value={heldItems.length} label="Awaiting sign-off" alert={heldItems.length > 0} />
            )}
            {canStats && stats.data && (
              <>
                <StatTile value={stats.data.visitorCount} label="Visits in 30 days" />
                <StatTile value={stats.data.uniqueVisitors} label="Unique visitors in 30 days" />
              </>
            )}
          </div>
        )}
        {cancelHold.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Check-in not cancelled"
            subtitle={cancelHold.error.message}
          />
        )}
        {canRead && (
          <section>
            {visits.isPending && <InlineLoadingState label="Loading attendance" />}
            {visits.isError && (
              <ErrorState
                title="Unable to load attendance"
                message="Check the connection and try again."
                onRetry={() => void visits.refetch()}
              />
            )}
            {checkOut.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Check-out failed"
                subtitle={checkOut.error.message}
              />
            )}
            {visits.data && (
              <CurrentlyHere
                visits={visits.data.items}
                holds={heldItems}
                canAssist={canAssist}
                canCorrect={canCorrect}
                canConfirm={canConfirm}
                busy={cancelHold.isPending}
                onCheckOut={(visit) => checkOut.mutate(visit.id)}
                onVoid={setVisitToVoid}
                onConfirm={(hold) => setDialog({ hold })}
                onCancelHold={(hold) => cancelHold.mutate(hold.id)}
              />
            )}
          </section>
        )}
      </Stack>

      <CheckInDialog
        open={dialog !== null}
        hold={dialog?.hold ?? null}
        subject={dialog?.subject ?? null}
        canConfirm={canConfirm}
        excludedPersonIds={excludedPersonIds}
        onClose={() => setDialog(null)}
        onWaiting={setWaitingNotice}
      />
      <VoidVisitDialog visit={visitToVoid} onClose={() => setVisitToVoid(null)} />
    </PageShell>
  );
}
