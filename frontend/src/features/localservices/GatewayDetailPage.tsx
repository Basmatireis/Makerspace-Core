import { useRef, useState } from 'react';
import {
  Button,
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  createStreamingGatewayCamera,
  createStreamingGatewayEnrollment,
  deleteStreamingGateway,
  deleteStreamingGatewayCamera,
  revokeStreamingGateway,
  updateStreamingGateway,
  updateStreamingGatewayCamera,
} from '../../api/generated/local-services/local-services';
import {
  type StreamingCamera,
  type StreamingGateway,
  type StreamingGatewayEnrollmentIssue,
} from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, FullPageLoading } from '../../app/PageState';
import { CameraStatusTag, EnrollmentSecretModal, GatewayFormModal, GatewayStatusTag, reenrollHint } from './components';
import { cameraAssignError, dateOrDash, errorText, isStale } from './helpers';
import { cameraCandidatesQuery, camerasQuery, gatewayQuery, localServiceKeys } from './queries';

const crumbs = [
  { label: 'Settings', to: '/settings' },
  { label: 'Local services', to: '/settings/local-services' },
];

export function GatewayDetailPage() {
  const { gatewayId = '' } = useParams();
  const query = useQuery(gatewayQuery(gatewayId));
  if (query.isPending)
    return (
      <PageShell title="Gateway" breadcrumbs={crumbs}>
        <FullPageLoading label="Loading gateway" />
      </PageShell>
    );
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <PageShell title={missing ? 'Gateway not found' : 'Gateway'} breadcrumbs={crumbs}>
        {missing ? (
          <EmptyState title="This gateway does not exist" description="It may have been deleted." />
        ) : (
          <ErrorState
            message={errorText(query.error, 'The gateway could not be loaded.')}
            onRetry={() => void query.refetch()}
          />
        )}
      </PageShell>
    );
  }
  return <Detail gateway={query.data} />;
}

type Dialog = 'edit' | 'revoke' | 'delete' | 'assign' | null;

function Detail({ gateway }: { gateway: StreamingGateway }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [issue, setIssue] = useState<StreamingGatewayEnrollmentIssue | null>(null);
  const [removing, setRemoving] = useState<StreamingCamera | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const revokeButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const cameras = useQuery(camerasQuery());
  const mine = (cameras.data?.items ?? []).filter((camera) => camera.gatewayId === gateway.id);
  const revoked = gateway.lifecycle === 'revoked';
  const refresh = () => queryClient.invalidateQueries({ queryKey: localServiceKeys.all });
  const failed = (error: unknown) =>
    setNotice(
      isStale(error) ? 'This gateway was changed somewhere else and has been refreshed. Try again.' : errorText(error),
    );
  const base = { name: gateway.name, publicHost: gateway.publicHost };

  const save = useMutation({
    mutationFn: (values: { name: string; publicHost: string }) =>
      updateStreamingGateway(gateway.id, {
        ...values,
        enabled: gateway.lifecycle !== 'disabled',
        expectedVersion: gateway.version,
      }),
    onSuccess: async () => {
      setDialog(null);
      await refresh();
    },
    onError: (error) => {
      if (isStale(error)) void refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: () =>
      updateStreamingGateway(gateway.id, {
        ...base,
        enabled: gateway.lifecycle === 'disabled',
        expectedVersion: gateway.version,
      }),
    onSuccess: async () => {
      setNotice(null);
      await refresh();
    },
    onError: (error) => {
      failed(error);
      void refresh();
    },
  });
  const enroll = useMutation({
    mutationFn: () => createStreamingGatewayEnrollment(gateway.id),
    onSuccess: async (result) => {
      setNotice(null);
      setIssue(result);
      await refresh();
    },
    onError: failed,
  });
  const revoke = useMutation({
    mutationFn: () => revokeStreamingGateway(gateway.id, { expectedVersion: gateway.version }),
    onSuccess: async () => {
      setDialog(null);
      await refresh();
    },
    onError: (error) => {
      if (isStale(error)) void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteStreamingGateway(gateway.id, { expectedVersion: gateway.version }),
    onSuccess: async () => {
      await refresh();
      navigate('/settings/local-services');
    },
    onError: (error) => {
      if (isStale(error)) void refresh();
    },
  });
  const setCamera = useMutation({
    mutationFn: (camera: StreamingCamera) =>
      updateStreamingGatewayCamera(gateway.id, camera.id, {
        enabled: !camera.enabled,
        expectedVersion: camera.version,
      }),
    onSuccess: async () => {
      setNotice(null);
      await refresh();
    },
    onError: (error) => {
      failed(error);
      void refresh();
    },
  });
  const removeCamera = useMutation({
    mutationFn: (camera: StreamingCamera) => deleteStreamingGatewayCamera(gateway.id, camera.id),
    onSuccess: async () => {
      setRemoving(null);
      await refresh();
    },
  });

  const now = Date.now();
  return (
    <PageShell title={gateway.name} description="Streaming gateway" width="wide" breadcrumbs={crumbs}>
      <Stack gap={6}>
        {notice && (
          <InlineNotification
            kind="error"
            lowContrast
            title="Action failed"
            subtitle={notice}
            onCloseButtonClick={() => setNotice(null)}
          />
        )}
        <StructuredListWrapper isCondensed aria-label="Gateway details">
          <StructuredListBody>
            <StructuredListRow>
              <StructuredListCell noWrap>Status</StructuredListCell>
              <StructuredListCell>
                <GatewayStatusTag gateway={gateway} now={now} />
                {gateway.healthSummary ? ` ${gateway.healthSummary}` : ''}
              </StructuredListCell>
            </StructuredListRow>
            <StructuredListRow>
              <StructuredListCell noWrap>Public host</StructuredListCell>
              <StructuredListCell>{gateway.publicHost}</StructuredListCell>
            </StructuredListRow>
            <StructuredListRow>
              <StructuredListCell noWrap>Version</StructuredListCell>
              <StructuredListCell>{gateway.softwareVersion ?? '—'}</StructuredListCell>
            </StructuredListRow>
            <StructuredListRow>
              <StructuredListCell noWrap>Last heartbeat</StructuredListCell>
              <StructuredListCell>{dateOrDash(gateway.lastHeartbeatAt)}</StructuredListCell>
            </StructuredListRow>
            <StructuredListRow>
              <StructuredListCell noWrap>Configuration</StructuredListCell>
              <StructuredListCell>
                Revision {gateway.configurationRevision}, applied {gateway.appliedConfigurationRevision}
              </StructuredListCell>
            </StructuredListRow>
            <StructuredListRow>
              <StructuredListCell noWrap>Enrolled</StructuredListCell>
              <StructuredListCell>{dateOrDash(gateway.enrolledAt)}</StructuredListCell>
            </StructuredListRow>
          </StructuredListBody>
        </StructuredListWrapper>

        <Stack orientation="horizontal" gap={3}>
          {!revoked && (
            <Button
              kind="tertiary"
              onClick={() => {
                save.reset();
                setDialog('edit');
              }}
            >
              Rename
            </Button>
          )}
          {!revoked && gateway.lifecycle !== 'pending' && (
            <Button kind="tertiary" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
              {gateway.lifecycle === 'disabled' ? 'Enable' : 'Disable'}
            </Button>
          )}
          {!revoked && (
            <Button
              kind="tertiary"
              disabled={enroll.isPending}
              title={gateway.lifecycle === 'pending' ? undefined : reenrollHint}
              onClick={() => enroll.mutate()}
            >
              New enrollment secret
            </Button>
          )}
          {!revoked && (
            <Button
              ref={revokeButton}
              kind="danger--tertiary"
              onClick={() => {
                revoke.reset();
                setDialog('revoke');
              }}
            >
              Revoke
            </Button>
          )}
          <Button
            ref={deleteButton}
            kind="danger"
            onClick={() => {
              remove.reset();
              setDialog('delete');
            }}
          >
            Delete
          </Button>
        </Stack>

        <section aria-labelledby="cameras-title">
          <Stack gap={4}>
            <Stack orientation="horizontal" gap={5}>
              <h2 id="cameras-title" className="cds--type-heading-03">
                Cameras
              </h2>
              {!revoked && (
                <Button size="sm" renderIcon={Add} onClick={() => setDialog('assign')}>
                  Assign camera
                </Button>
              )}
            </Stack>
            {mine.length === 0 ? (
              <EmptyState
                title="No cameras assigned"
                description="Assign the camera of a Bambu printer. Displays then show it while the printer prints."
              />
            ) : (
              <TableContainer>
                <Table aria-label="Cameras">
                  <TableHead>
                    <TableRow>
                      <TableHeader>Machine</TableHeader>
                      <TableHeader>Status</TableHeader>
                      <TableHeader>Viewers</TableHeader>
                      <TableHeader>Last seen</TableHeader>
                      <TableHeader>
                        <span className="cds--visually-hidden">Actions</span>
                      </TableHeader>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {mine.map((camera) => (
                      <TableRow key={camera.id}>
                        <TableCell>{camera.machineName}</TableCell>
                        <TableCell>
                          <CameraStatusTag camera={camera} />
                        </TableCell>
                        <TableCell>{camera.viewers ?? '—'}</TableCell>
                        <TableCell>{dateOrDash(camera.reportedAt)}</TableCell>
                        <TableCell>
                          <Stack orientation="horizontal" gap={2}>
                            <Button
                              size="sm"
                              kind="ghost"
                              disabled={setCamera.isPending}
                              onClick={() => setCamera.mutate(camera)}
                            >
                              {camera.enabled ? 'Disable' : 'Enable'}
                              <span className="cds--visually-hidden"> camera of {camera.machineName}</span>
                            </Button>
                            <Button
                              size="sm"
                              kind="danger--ghost"
                              onClick={() => {
                                removeCamera.reset();
                                setRemoving(camera);
                              }}
                            >
                              Remove<span className="cds--visually-hidden"> camera of {camera.machineName}</span>
                            </Button>
                          </Stack>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Stack>
        </section>
      </Stack>

      {dialog === 'edit' && (
        <GatewayFormModal
          gateway={gateway}
          pending={save.isPending}
          error={save.isError ? errorText(save.error) : undefined}
          onSubmit={(values) => save.mutate(values)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'assign' && (
        <AssignCameraModal
          gatewayId={gateway.id}
          onClose={() => setDialog(null)}
          onAssigned={() => {
            setDialog(null);
            void refresh();
          }}
        />
      )}
      <DestructiveActionDialog
        open={dialog === 'revoke'}
        title="Revoke gateway"
        confirmLabel="Revoke"
        pending={revoke.isPending}
        error={revoke.isError ? errorText(revoke.error) : undefined}
        launcherButtonRef={revokeButton}
        onConfirm={() => revoke.mutate()}
        onClose={() => setDialog(null)}
      >
        <p>
          {gateway.name} loses access to Core immediately and stops streaming. Displays lose their cameras within five
          minutes. This cannot be undone; the gateway has to be set up again as a new gateway.
        </p>
      </DestructiveActionDialog>
      <DestructiveActionDialog
        open={dialog === 'delete'}
        title="Delete gateway"
        confirmLabel="Delete"
        pending={remove.isPending}
        error={remove.isError ? errorText(remove.error) : undefined}
        launcherButtonRef={deleteButton}
        onConfirm={() => remove.mutate()}
        onClose={() => setDialog(null)}
      >
        <p>
          The gateway is revoked and removed. A running instance stops working; its cameras must be assigned to another
          one. {gateway.name} is deleted permanently with its credentials and camera assignments.
        </p>
      </DestructiveActionDialog>
      <DestructiveActionDialog
        open={removing !== null}
        title="Remove camera"
        confirmLabel="Remove"
        pending={removeCamera.isPending}
        error={removeCamera.isError ? errorText(removeCamera.error) : undefined}
        onConfirm={() => removing && removeCamera.mutate(removing)}
        onClose={() => setRemoving(null)}
      >
        <p>Displays stop showing the camera of {removing?.machineName}; camera widgets show their fallback.</p>
      </DestructiveActionDialog>
      {issue && <EnrollmentSecretModal gateway={gateway} issue={issue} onClose={() => setIssue(null)} />}
    </PageShell>
  );
}

function AssignCameraModal({
  gatewayId,
  onClose,
  onAssigned,
}: {
  gatewayId: string;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const [machineId, setMachineId] = useState('');
  const candidates = useQuery(cameraCandidatesQuery());
  const free = candidates.data?.items ?? [];
  const assign = useMutation({
    mutationFn: () => createStreamingGatewayCamera(gatewayId, { machineId, enabled: true }),
    onSuccess: onAssigned,
  });
  const submit = () => {
    if (machineId) assign.mutate();
  };
  return (
    <Modal
      open
      size="sm"
      modalLabel="Cameras"
      modalHeading="Assign camera"
      primaryButtonText={assign.isPending ? 'Assigning…' : 'Assign camera'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={assign.isPending || !machineId}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!assign.isPending) onClose();
      }}
      onRequestSubmit={submit}
    >
      <Stack gap={5}>
        <Select
          id="camera-machine"
          labelText="Machine"
          value={machineId}
          helperText="Only printers with an active Bambu H2D or X1 Carbon assignment (Settings, Local services, Printer connectors) can stream."
          onChange={(event) => {
            setMachineId(event.target.value);
            assign.reset();
          }}
        >
          <SelectItem value="" text="Choose a machine" />
          {free.map((machine) => (
            <SelectItem key={machine.id} value={machine.id} text={machine.name} />
          ))}
        </Select>
        {assign.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Camera not assigned"
            subtitle={cameraAssignError(assign.error)}
          />
        )}
      </Stack>
    </Modal>
  );
}
