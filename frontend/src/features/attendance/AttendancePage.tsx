import {
  Button,
  ComposedModal,
  Form,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Stack,
  TextArea,
  TextInput,
  Tile,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  getAttendanceStatistics,
  listVisits,
  supervisedVisitCheckIn,
  supervisedVisitCheckOut,
  voidVisit,
} from '../../api/generated/attendance/attendance';
import type { Visit } from '../../api/generated/models';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { PageShell } from '../../app/PageShell';
import { useLatestCallback } from '../../app/useLatestCallback';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';

const visitsKey = ['attendance', 'visits'] as const;

export function AttendancePage() {
  const user = useCurrentUser();
  const queryClient = useQueryClient();
  const canRead = hasPermission(user, PermissionId.attendanceread);
  const canAssist = hasPermission(user, PermissionId.attendanceassist);
  const canCorrect = hasPermission(user, PermissionId.attendancecorrect);
  const canStats = hasPermission(user, PermissionId.attendancestatisticsread);
  const [personId, setPersonId] = useState('');
  const [visitToVoid, setVisitToVoid] = useState<Visit | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const visits = useQuery({
    queryKey: visitsKey,
    queryFn: ({ signal }) => listVisits({ currentlyHere: true }, { signal }),
    refetchInterval: 30_000,
    enabled: canRead,
  });
  const now = new Date();
  const from = new Date(now);
  from.setDate(now.getDate() - 30);
  const stats = useQuery({
    queryKey: ['attendance', 'statistics', from.toISOString().slice(0, 10)],
    queryFn: ({ signal }) => getAttendanceStatistics({ from: from.toISOString(), to: now.toISOString() }, { signal }),
    enabled: canStats,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: visitsKey });
  const checkIn = useMutation({
    mutationFn: () => supervisedVisitCheckIn({ personId: personId.trim() }),
    onSuccess: async () => {
      setPersonId('');
      await refresh();
    },
  });
  const checkOut = useMutation({ mutationFn: (id: string) => supervisedVisitCheckOut(id), onSuccess: refresh });
  const voidMutation = useMutation({
    mutationFn: ({ visit, reason }: { visit: Visit; reason: string }) =>
      voidVisit(visit.id, { expectedVersion: visit.version, reason }),
    onSuccess: async () => {
      setVisitToVoid(null);
      setVoidReason('');
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ['attendance', 'statistics'] });
    },
  });
  const closeVoidDialog = useLatestCallback(() => {
    if (voidMutation.isPending) return false;
    setVisitToVoid(null);
    setVoidReason('');
    voidMutation.reset();
    return false;
  });

  return (
    <PageShell title="Attendance" description="See who is currently here and assist with check-in or checkout.">
      <Stack gap={6}>
        {canStats && stats.data && (
          <div className="stats-grid">
            <Tile>
              <strong>{stats.data.currentOccupancy}</strong>
              <span>Currently here</span>
            </Tile>
            <Tile>
              <strong>{stats.data.visitorCount}</strong>
              <span>Visits in 30 days</span>
            </Tile>
            <Tile>
              <strong>{stats.data.uniqueVisitors}</strong>
              <span>Unique visitors</span>
            </Tile>
            <Tile>
              <strong>{Number(stats.data.visitorHours).toFixed(1)}</strong>
              <span>Visitor hours</span>
            </Tile>
          </div>
        )}
        {canAssist && (
          <Tile>
            <Form
              onSubmit={(event) => {
                event.preventDefault();
                checkIn.mutate();
              }}
            >
              <Stack gap={4}>
                <h2>Assisted check-in</h2>
                <TextInput
                  id="attendance-person-id"
                  labelText="Person ID"
                  value={personId}
                  onChange={(event) => setPersonId(event.target.value)}
                />
                {checkIn.isError && (
                  <InlineNotification
                    kind="error"
                    lowContrast
                    hideCloseButton
                    title="Check-in failed"
                    subtitle={checkIn.error.message}
                  />
                )}
                <Button type="submit" disabled={!personId.trim() || checkIn.isPending}>
                  Check in person
                </Button>
              </Stack>
            </Form>
          </Tile>
        )}
        {canRead && (
          <section>
            <h2>Currently here</h2>
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
            <Stack gap={3}>
              {visits.data?.items.map((visit) => (
                <Tile key={visit.id}>
                  <div className="section-heading">
                    <div>
                      <strong>{visit.displayName}</strong>
                      <p>Checked in {new Date(visit.checkedInAt).toLocaleString()}</p>
                    </div>
                    <div className="button-cluster">
                      {canAssist && (
                        <Button
                          kind="ghost"
                          size="sm"
                          disabled={checkOut.isPending || voidMutation.isPending}
                          onClick={() => checkOut.mutate(visit.id)}
                        >
                          Check out
                        </Button>
                      )}
                      {canCorrect && (
                        <Button
                          kind="danger--ghost"
                          size="sm"
                          disabled={checkOut.isPending || voidMutation.isPending}
                          onClick={() => {
                            voidMutation.reset();
                            setVoidReason('');
                            setVisitToVoid(visit);
                          }}
                        >
                          Void record
                        </Button>
                      )}
                    </div>
                  </div>
                </Tile>
              ))}
              {visits.data?.items.length === 0 && <p>Nobody is currently checked in.</p>}
            </Stack>
          </section>
        )}
      </Stack>

      <ComposedModal
        open={Boolean(visitToVoid)}
        danger
        size="sm"
        selectorPrimaryFocus=".cds--btn--secondary"
        preventCloseOnClickOutside
        onClose={closeVoidDialog}
      >
        <ModalHeader title={`Void attendance record for ${visitToVoid?.displayName ?? ''}?`} />
        <ModalBody>
          <Stack gap={5}>
            <p>
              The visit will be marked void and removed from current presence. Pending post-visit survey invitations are
              cancelled. The correction and its audit history remain recorded.
            </p>
            <TextArea
              id="void-visit-reason"
              labelText="Correction reason"
              maxLength={500}
              value={voidReason}
              onChange={(event) => setVoidReason(event.target.value)}
            />
            {voidMutation.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Attendance record not voided"
                subtitle={voidMutation.error.message}
              />
            )}
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" disabled={voidMutation.isPending} onClick={closeVoidDialog}>
            Cancel
          </Button>
          <Button
            kind="danger"
            disabled={!voidReason.trim() || voidMutation.isPending}
            onClick={() => visitToVoid && voidMutation.mutate({ visit: visitToVoid, reason: voidReason.trim() })}
          >
            {voidMutation.isPending ? 'Voiding…' : 'Void record'}
          </Button>
        </ModalFooter>
      </ComposedModal>
    </PageShell>
  );
}
