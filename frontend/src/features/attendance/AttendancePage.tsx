import { Button, InlineNotification, Stack } from '@carbon/react';
import { UserFollow } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { supervisedVisitCheckOut } from '../../api/generated/attendance/attendance';
import type { Visit } from '../../api/generated/models';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { PageShell } from '../../app/PageShell';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { CurrentlyHere } from './components/CurrentlyHere';
import { StatTile } from './components/StatTiles';
import { CheckInDialog } from './dialogs/CheckInDialog';
import { VoidVisitDialog } from './dialogs/VoidVisitDialog';
import { attendanceKeys, statisticsOptions, visitsOptions } from './queries';
import './attendance.scss';

export function AttendancePage() {
  const user = useCurrentUser();
  const queryClient = useQueryClient();
  const canRead = hasPermission(user, PermissionId.attendanceread);
  const canAssist = hasPermission(user, PermissionId.attendanceassist);
  const canCorrect = hasPermission(user, PermissionId.attendancecorrect);
  const canStats = hasPermission(user, PermissionId.attendancestatisticsread);
  const canSearchPeople = hasPermission(user, PermissionId.peoplereadall);
  const [dialog, setDialog] = useState(false);
  const [visitToVoid, setVisitToVoid] = useState<Visit | null>(null);
  const visits = useQuery(visitsOptions(canRead));
  const stats = useQuery(statisticsOptions(canStats));
  const refresh = () => queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
  const checkOut = useMutation({ mutationFn: (id: string) => supervisedVisitCheckOut(id), onSuccess: refresh });

  const hereCount = canRead ? visits.data?.items.length : stats.data?.currentOccupancy;
  const excludedPersonIds = new Set((visits.data?.items ?? []).map((visit) => visit.personId));
  const showTiles = hereCount !== undefined || (canStats && stats.data);

  return (
    <PageShell
      title="Attendance"
      width="wide"
      actions={
        canAssist && canSearchPeople ? (
          <Button renderIcon={UserFollow} onClick={() => setDialog(true)}>
            Check someone in
          </Button>
        ) : undefined
      }
    >
      <Stack gap={7}>
        {showTiles && (
          <div className="attendance-stats">
            {hereCount !== undefined && <StatTile value={hereCount} label="Currently here" />}
            {canStats && stats.data && (
              <>
                <StatTile value={stats.data.visitorCount} label="Visits in 30 days" />
                <StatTile value={stats.data.uniqueVisitors} label="Unique visitors in 30 days" />
              </>
            )}
          </div>
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
                canAssist={canAssist}
                canCorrect={canCorrect}
                onCheckOut={(visit) => checkOut.mutate(visit.id)}
                onVoid={setVisitToVoid}
              />
            )}
          </section>
        )}
      </Stack>

      <CheckInDialog open={dialog} excludedPersonIds={excludedPersonIds} onClose={() => setDialog(false)} />
      <VoidVisitDialog visit={visitToVoid} onClose={() => setVisitToVoid(null)} />
    </PageShell>
  );
}
