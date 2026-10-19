import { useState, type ReactNode } from 'react';
import {
  Button, CodeSnippet, ComposedModal, DataTable, InlineNotification, Link as CarbonLink, Modal, ModalBody, ModalFooter, ModalHeader, OverflowMenu, OverflowMenuItem,
  Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, TableToolbar, TableToolbarContent, Tag, TextInput,
} from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { PrinterConnector } from '../../../api/generated/models';
import { createPrinterConnector, createPrinterConnectorEnrollment, revokePrinterConnector, updatePrinterConnector } from '../../../api/generated/printer-connectors/printer-connectors';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { EmptyState } from '../../../app/PageState';
import { assignmentsQuery, connectorKeys, connectorsQuery } from '../connectorQueries';
import { formatRelative } from '../shared/format';
import { machineLogbookPaths } from '../shared/paths';
import { QueryBoundary } from '../shared/QueryBoundary';
import { connectorStatus } from '../shared/connectorStatus';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';
import { useNow } from '../shared/useNow';
import { DiagnosticsModal } from './ConnectorDiagnostics';

const headers = [
  { key: 'name', header: 'Connector' }, { key: 'status', header: 'Status' }, { key: 'heartbeat', header: 'Last heartbeat' },
  { key: 'printers', header: 'Printers' }, { key: 'version', header: 'Software' }, { key: 'queue', header: 'Event queue' },
];

function AddConnectorModal({ canEnroll, onClose, onCreated }: { canEnroll: boolean; onClose: () => void; onCreated: (secret: string | null) => void }) {
  const client = useQueryClient();
  const notify = useNotify();
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const create = useMutation({
    mutationFn: async () => {
      const connector = await createPrinterConnector({ name: name.trim(), locationLabel: location.trim() || null });
      // A connector can only be used once it is enrolled, so the secret is issued right away for those who may.
      const secret = canEnroll ? (await createPrinterConnectorEnrollment(connector.id)).enrollmentSecret : null;
      return { connector, secret };
    },
    onSuccess: async ({ connector, secret }) => {
      notify({ kind: 'success', title: 'Connector created', subtitle: connector.name });
      await client.invalidateQueries({ queryKey: connectorKeys.all });
      onCreated(secret);
    },
  });
  const submit = () => { if (name.trim() && !create.isPending) create.mutate(); };
  return (
    <Modal
      open size="xs" modalHeading="Add connector" primaryButtonText={create.isPending ? 'Creating…' : 'Create'} secondaryButtonText="Cancel"
      primaryButtonDisabled={!name.trim() || create.isPending} preventCloseOnClickOutside onRequestClose={() => { if (!create.isPending) onClose(); }} onRequestSubmit={submit}
    >
      <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <Stack gap={5}>
          <TextInput id="connector-name" labelText="Connector name" value={name} maxLength={120} autoComplete="off" data-modal-primary-focus onChange={(event) => setName(event.target.value)} />
          <TextInput id="connector-location" labelText="Location (optional)" value={location} maxLength={200} autoComplete="off" onChange={(event) => setLocation(event.target.value)} />
          {create.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Connector not created" subtitle="Review the values and try again." />}
        </Stack>
      </form>
    </Modal>
  );
}

function SecretModal({ secret, onClose }: { secret: string; onClose: () => void }) {
  return (
    <ComposedModal open size="sm" preventCloseOnClickOutside onClose={onClose} aria-label="Enrollment secret">
      <ModalHeader title="Enrollment secret" label="Connector" />
      <ModalBody>
        <Stack gap={5}>
          <InlineNotification kind="warning" lowContrast hideCloseButton title="Copy this enrollment secret now." subtitle="It expires after 15 minutes and can't be shown again. Put it in the connector's enrollment secret file." />
          <CodeSnippet type="multi">{secret}</CodeSnippet>
        </Stack>
      </ModalBody>
      <ModalFooter><Button kind="primary" onClick={onClose}>I have stored the secret</Button></ModalFooter>
    </ComposedModal>
  );
}

export function ConnectorsTab({ switcher }: { switcher?: ReactNode }) {
  const can = useCan();
  const client = useQueryClient();
  const notify = useNotify();
  const now = useNow();
  const canManage = can('printer_connectors.manage');
  const canCredentials = can('printer_connectors.credentials.manage');
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<PrinterConnector | null>(null);
  const connectors = useQuery({ ...connectorsQuery(), refetchInterval: 30_000 });
  const items = connectors.data?.items ?? [];
  const assignments = useQueries({ queries: items.map((connector) => ({ ...assignmentsQuery(connector.id), refetchInterval: 30_000 })) });
  const refresh = () => client.invalidateQueries({ queryKey: connectorKeys.all });
  const failed = (title: string) => () => notify({ kind: 'error', title, subtitle: 'The connector may have changed. Reload and try again.' });

  const enroll = useMutation({
    mutationFn: (connector: PrinterConnector) => createPrinterConnectorEnrollment(connector.id),
    onSuccess: async (issue) => { setSecret(issue.enrollmentSecret); await refresh(); },
    onError: failed('Enrollment secret not issued'),
  });
  const setEnabled = useMutation({
    mutationFn: ({ connector, enabled }: { connector: PrinterConnector; enabled: boolean }) => updatePrinterConnector(connector.id, { name: connector.name, locationLabel: connector.locationLabel, enabled, expectedVersion: connector.version }),
    onSuccess: async (saved, { enabled }) => { notify({ kind: 'success', title: enabled ? 'Connector enabled' : 'Connector disabled', subtitle: saved.name }); await refresh(); },
    onError: failed('Connector not updated'),
  });
  const revoke = useMutation({
    mutationFn: (connector: PrinterConnector) => revokePrinterConnector(connector.id, { expectedVersion: connector.version }),
    onSuccess: async (_saved, connector) => { notify({ kind: 'success', title: 'Connector revoked', subtitle: connector.name }); setRevoking(null); await refresh(); },
  });

  const printersOf = (connectorId: string) => {
    const index = items.findIndex((item) => item.id === connectorId);
    const seen = new Set<string>();
    return (assignments[index]?.data?.items ?? []).filter((assignment) => !assignment.endedAt && !seen.has(assignment.machineId) && seen.add(assignment.machineId));
  };
  const rows = items.map((connector) => ({
    id: connector.id, name: connector.name, status: connectorStatus(connector, now).label, heartbeat: connector.lastHeartbeatAt ?? '', printers: printersOf(connector.id).length,
    version: connector.softwareVersion ?? '', queue: connector.pendingEventCount,
  }));
  const diagnosticConnector = items.find((connector) => connector.id === diagnostics);

  return (
    <div className="mj-stack">
      <QueryBoundary query={connectors} errorMessage="The printer connectors could not be loaded.">
        <DataTable rows={rows} headers={headers}>
          {({ rows: tableRows, headers: tableHeaders, getRowProps, getTableProps }) => (
            <TableContainer className="mj-table-container">
              <TableToolbar aria-label="Connectors toolbar">
                {switcher}
                <TableToolbarContent>
                  {canManage && <Button kind="primary" size="lg" renderIcon={Add} onClick={() => setAdding(true)}>Add connector</Button>}
                </TableToolbarContent>
              </TableToolbar>
              <Table {...getTableProps()} aria-label="Printer connectors">
                <TableHead>
                  <TableRow>
                    {tableHeaders.map((header) => <TableHeader key={header.key}>{header.header}</TableHeader>)}
                    <TableHeader aria-label="Actions" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {tableRows.map((row) => {
                    const connector = items.find((item) => item.id === row.id);
                    if (!connector) return null;
                    const status = connectorStatus(connector, now);
                    const printers = printersOf(connector.id);
                    const { key, ...rowProps } = getRowProps({ row });
                    return (
                      <TableRow key={key} {...rowProps}>
                        <TableCell><div className="mj-cell-stack"><span>{connector.name}</span>{connector.locationLabel && <span className="mj-secondary">{connector.locationLabel}</span>}</div></TableCell>
                        <TableCell><Tag size="sm" type={status.type}>{status.label}</Tag></TableCell>
                        <TableCell>{connector.lastHeartbeatAt ? formatRelative(connector.lastHeartbeatAt) : 'Never'}</TableCell>
                        <TableCell>
                          {printers.length === 0 ? <span className="mj-secondary">None</span> : (
                            <span className="mj-inline">{printers.map((assignment) => <CarbonLink key={assignment.id} as={Link} to={machineLogbookPaths.machine(assignment.machineId)}>{assignment.machineName}</CarbonLink>)}</span>
                          )}
                        </TableCell>
                        <TableCell>{connector.softwareVersion ?? '—'}</TableCell>
                        <TableCell>{connector.pendingEventCount} pending · {connector.quarantinedEventCount} quarantined</TableCell>
                        <TableCell className="cds--table-column-menu">
                          <OverflowMenu aria-label={`Actions for ${connector.name}`} iconDescription={`Actions for ${connector.name}`} flipped size="sm">
                            <OverflowMenuItem itemText="Diagnostics" onClick={() => setDiagnostics(connector.id)} />
                            {canCredentials && connector.lifecycle === 'pending' && (
                              <OverflowMenuItem itemText="Enroll" disabled={enroll.isPending} onClick={() => enroll.mutate(connector)} />
                            )}
                            {canManage && (connector.lifecycle === 'active' || connector.lifecycle === 'disabled') && (
                              <OverflowMenuItem
                                itemText={connector.lifecycle === 'disabled' ? 'Enable' : 'Disable'} disabled={setEnabled.isPending}
                                onClick={() => setEnabled.mutate({ connector, enabled: connector.lifecycle === 'disabled' })}
                              />
                            )}
                            {canCredentials && connector.lifecycle !== 'revoked' && <OverflowMenuItem itemText="Revoke" isDelete hasDivider onClick={() => { revoke.reset(); setRevoking(connector); }} />}
                          </OverflowMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {items.length === 0 && <EmptyState title="No connectors yet" description="Add a connector to collect prints automatically." action={canManage ? <Button kind="tertiary" onClick={() => setAdding(true)}>Add connector</Button> : undefined} />}
            </TableContainer>
          )}
        </DataTable>
      </QueryBoundary>
      <p className="mj-secondary">Connectors are the agents next to your printers. They observe printers and deliver events to Core. Printers are assigned to a connector from the printer's own setup.</p>
      {adding && <AddConnectorModal canEnroll={canCredentials} onClose={() => setAdding(false)} onCreated={(value) => { setAdding(false); setSecret(value); }} />}
      {secret && <SecretModal secret={secret} onClose={() => setSecret(null)} />}
      {diagnosticConnector && <DiagnosticsModal connector={diagnosticConnector} onClose={() => setDiagnostics(null)} />}
      <DestructiveActionDialog
        open={Boolean(revoking)} title={`Revoke ${revoking?.name ?? 'connector'}?`} confirmLabel="Revoke connector" pending={revoke.isPending}
        error={revoke.isError ? 'The connector could not be revoked. Reload and try again.' : undefined}
        onClose={() => setRevoking(null)} onConfirm={() => { if (revoking) revoke.mutate(revoking); }}
      >
        <p>
          The connector can no longer deliver events, and this can't be undone.
          {revoking && printersOf(revoking.id).length > 0 ? ` ${printersOf(revoking.id).map((assignment) => assignment.machineName).join(', ')} will stop collecting prints automatically until reassigned.` : ''}
        </p>
      </DestructiveActionDialog>
    </div>
  );
}
