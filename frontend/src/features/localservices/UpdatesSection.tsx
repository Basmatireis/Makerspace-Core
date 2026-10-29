import { useState } from 'react';
import {
  Button,
  CodeSnippet,
  InlineNotification,
  Modal,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LocalServiceUpdate } from '../../api/generated/models';
import { requestPrinterConnectorUpdate } from '../../api/generated/printer-connectors/printer-connectors';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { connectorKeys, connectorsQuery } from '../machinelogbook/connectorQueries';
import { dateOrDash, errorText, isNewerRelease, isRelease } from './helpers';

type ServiceRow = {
  id: string;
  name: string;
  active: boolean;
  running: string | null;
  updaterAvailable: boolean;
  update: LocalServiceUpdate | null;
};

const statusLabels: Record<LocalServiceUpdate['status'], { label: string; type: 'blue' | 'green' | 'red' | 'gray' }> = {
  requested: { label: 'Update requested', type: 'blue' },
  in_progress: { label: 'Updating', type: 'blue' },
  succeeded: { label: 'Updated', type: 'green' },
  failed: { label: 'Update failed', type: 'red' },
};

const reasonTexts: Record<string, string> = {
  pull_failed: 'The new images could not be downloaded. The previous version keeps running.',
  up_failed: 'The new version did not start; the previous version was started again.',
  downgrade_refused: 'The host already runs a newer version.',
  env_invalid: 'The .env file of the bundle has no single MAKERSPACE_VERSION release value.',
  env_write_failed: 'The .env file of the bundle could not be written.',
  invalid_request: 'The updater refused the request.',
  interrupted: 'The updater was stopped during the update.',
  already_installed: 'The version was already installed.',
};

/** An open request stops blocking a new one after this time, like on the server. */
const REQUEST_TIMEOUT_MS = 15 * 60_000;

function manualCommand(version: string) {
  return [
    '# on the host, in the directory with compose.yaml and .env',
    `sed -i 's/^MAKERSPACE_VERSION=.*/MAKERSPACE_VERSION=${version}/' .env`,
    'docker compose pull && docker compose up -d',
  ].join('\n');
}

/**
 * Versions of all printer connectors the user can see, compared with Core's version, and the update requests for the
 * connectors that run the optional updater sidecar. A connector bundle contains the camera relay too.
 */
export function UpdatesSection({ canManageConnectors }: { canManageConnectors: boolean }) {
  const queryClient = useQueryClient();
  const connectors = useQuery({ ...connectorsQuery(), refetchInterval: 10_000 });
  const [confirming, setConfirming] = useState<ServiceRow | null>(null);
  const coreVersion = connectors.data?.coreVersion ?? null;
  const request = useMutation({
    mutationFn: ({ row, version }: { row: ServiceRow; version: string }) =>
      requestPrinterConnectorUpdate(row.id, { targetVersion: version }),
    onSuccess: async () => {
      setConfirming(null);
      await queryClient.invalidateQueries({ queryKey: connectorKeys.all });
    },
  });

  if (connectors.isPending) return <InlineLoadingState label="Loading versions" />;
  if (connectors.isError) {
    return (
      <ErrorState
        message="The versions of the printer connectors could not be loaded."
        onRetry={() => void connectors.refetch()}
      />
    );
  }

  const rows: ServiceRow[] = connectors.data.items
    .filter((item) => item.lifecycle !== 'revoked')
    .map((item) => ({
      id: item.id,
      name: item.name,
      active: item.lifecycle === 'active',
      running: item.softwareVersion,
      updaterAvailable: item.updaterAvailable,
      update: item.update,
    }));
  const released = isRelease(coreVersion);
  const open = (row: ServiceRow) =>
    row.update !== null &&
    (row.update.status === 'requested' || row.update.status === 'in_progress') &&
    Date.now() - Date.parse(row.update.statusAt) < REQUEST_TIMEOUT_MS;
  const available = (row: ServiceRow) => released && isNewerRelease(coreVersion, row.running);
  const manual = rows.filter((row) => available(row) && !row.updaterAvailable);

  return (
    <Stack gap={5}>
      <p>
        Core runs version <strong>{coreVersion ?? '—'}</strong>. Printer connectors are updated to exactly this version.
      </p>
      {!released && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Development build"
          subtitle="This Core is not a release, so it offers no updates."
        />
      )}
      {rows.length === 0 ? (
        <p>No printer connectors yet.</p>
      ) : (
        <TableContainer className="mj-table-container local-services-table">
          <Table aria-label="Versions and updates">
            <TableHead>
              <TableRow>
                <TableHeader>Service</TableHeader>
                <TableHeader>Running version</TableHeader>
                <TableHeader>Status</TableHeader>
                <TableHeader>
                  <span className="cds--visually-hidden">Actions</span>
                </TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => {
                const status = row.update ? statusLabels[row.update.status] : null;
                const reason = row.update?.reason ? (reasonTexts[row.update.reason] ?? row.update.reason) : null;
                return (
                  <TableRow key={row.id}>
                    <TableCell>{row.name}</TableCell>
                    <TableCell>{row.running ?? '—'}</TableCell>
                    <TableCell>
                      <Stack gap={2}>
                        <span>
                          {available(row) ? (
                            <Tag size="sm" type="purple">
                              Update available
                            </Tag>
                          ) : released && row.running === coreVersion ? (
                            <Tag size="sm" type="green">
                              Up to date
                            </Tag>
                          ) : null}
                          {status && (
                            <Tag size="sm" type={status.type} title={dateOrDash(row.update?.statusAt)}>
                              {status.label}
                            </Tag>
                          )}
                        </span>
                        {row.update?.status === 'failed' && reason && <span>{reason}</span>}
                        {available(row) && !row.updaterAvailable && (
                          <span>No updater on this host: update it by hand.</span>
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      {available(row) && row.updaterAvailable && row.active && canManageConnectors && (
                        <Button
                          kind="tertiary"
                          size="sm"
                          disabled={open(row)}
                          onClick={() => {
                            request.reset();
                            setConfirming(row);
                          }}
                        >
                          Update to {coreVersion}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {manual.length > 0 && coreVersion && (
        <Stack gap={3}>
          <p>
            Without the optional updater sidecar ({manual.map((row) => row.name).join(', ')}), update on the host
            itself. To update from here, enable the updater in the bundle (see the hosting documentation); it gets
            access to the Docker socket, which means root access to that host.
          </p>
          <CodeSnippet type="multi" feedback="Copied" aria-label="Manual update commands">
            {manualCommand(coreVersion)}
          </CodeSnippet>
        </Stack>
      )}
      {confirming && coreVersion && (
        <Modal
          open
          size="sm"
          modalHeading={`Update ${confirming.name} to ${coreVersion}?`}
          primaryButtonText={request.isPending ? 'Requesting…' : 'Update'}
          secondaryButtonText="Cancel"
          primaryButtonDisabled={request.isPending}
          preventCloseOnClickOutside
          onRequestClose={() => setConfirming(null)}
          onSecondarySubmit={() => setConfirming(null)}
          onRequestSubmit={() => request.mutate({ row: confirming, version: coreVersion })}
        >
          <Stack gap={5}>
            <p>
              The updater on the host downloads version {coreVersion} and restarts the connector within a minute or two.
              Running prints are not affected; the printer data and camera streams are interrupted briefly.
            </p>
            {request.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Update not requested"
                subtitle={errorText(request.error)}
              />
            )}
          </Stack>
        </Modal>
      )}
    </Stack>
  );
}
