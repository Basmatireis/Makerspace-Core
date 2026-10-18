import { useState } from 'react';
import {
  Button, CodeSnippet, ComposedModal, DataTable, InlineNotification, Link as CarbonLink, Modal, ModalBody, ModalFooter, ModalHeader, OverflowMenu, OverflowMenuItem,
  Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, TableToolbar, TableToolbarContent, Tag, TextInput,
} from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { Link } from 'react-router-dom';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { EmptyState } from '../../../app/PageState';
import { connectorStatus, formatRelative } from '../derived';
import { useSimulatedMutation, useStore } from '../store';
import type { ConnectorHost } from '../types';
import { DiagnosticsModal } from './ConnectorDiagnostics';

const headers = [
  { key: 'name', header: 'Connector' }, { key: 'status', header: 'Status' }, { key: 'heartbeat', header: 'Last heartbeat' },
  { key: 'printers', header: 'Printers' }, { key: 'version', header: 'Software' }, { key: 'queue', header: 'Event queue' },
];

function AddConnectorModal({ onClose, onCreated }: { onClose: () => void; onCreated: (secret: string) => void }) {
  const store = useStore();
  const { mutate, pending } = useSimulatedMutation(store.createConnector);
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const submit = async () => {
    if (!name.trim() || pending) return;
    const secret = await mutate(name.trim(), location.trim() || null);
    store.notify({ kind: 'success', title: 'Connector created', subtitle: name.trim() });
    onCreated(secret);
  };
  return (
    <Modal open size="xs" modalHeading="Add connector" primaryButtonText={pending ? 'Creating…' : 'Create'} secondaryButtonText="Cancel" primaryButtonDisabled={!name.trim() || pending} preventCloseOnClickOutside onRequestClose={onClose} onRequestSubmit={() => { void submit(); }}>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Stack gap={5}>
          <TextInput id="connector-name" labelText="Connector name" value={name} maxLength={120} autoComplete="off" data-modal-primary-focus onChange={(event) => setName(event.target.value)} />
          <TextInput id="connector-location" labelText="Location (optional)" value={location} maxLength={200} autoComplete="off" onChange={(event) => setLocation(event.target.value)} />
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

export function ConnectorsTab() {
  const store = useStore();
  const canManage = store.can('printer_connectors.manage');
  const canCredentials = store.can('printer_connectors.credentials.manage');
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<ConnectorHost | null>(null);
  const [revoking, setRevoking] = useState<ConnectorHost | null>(null);
  const enroll = useSimulatedMutation(store.enrollConnector);
  const setEnabled = useSimulatedMutation(store.setConnectorEnabled);
  const revoke = useSimulatedMutation(store.revokeConnector);
  const printersOf = (host: ConnectorHost) => store.machines.filter((machine) => machine.connection?.connectorId === host.id);

  const rows = store.connectorHosts.map((host) => ({ id: host.id, name: host.name, status: connectorStatus(host).label, heartbeat: host.lastHeartbeatAt ?? '', printers: printersOf(host).length, version: host.softwareVersion ?? '', queue: host.pendingEventCount }));

  return (
    <div className="mj-tab-panel">
      <p className="mj-secondary">Connectors are the agents next to your printers. They observe printers and deliver events to Core. Printers are assigned to a connector from the printer's own setup.</p>
      <DataTable rows={rows} headers={headers}>
        {({ rows: tableRows, headers: tableHeaders, getRowProps, getTableProps }) => (
          <TableContainer className="mj-table-container">
            <TableToolbar aria-label="Connectors toolbar">
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
                  const host = store.connectorHosts.find((item) => item.id === row.id)!;
                  const status = connectorStatus(host);
                  const printers = printersOf(host);
                  const { key, ...rowProps } = getRowProps({ row });
                  return (
                    <TableRow key={key} {...rowProps}>
                      <TableCell><div className="mj-cell-stack"><span>{host.name}</span>{host.locationLabel && <span className="mj-secondary">{host.locationLabel}</span>}</div></TableCell>
                      <TableCell><Tag size="sm" type={status.type}>{status.label}</Tag></TableCell>
                      <TableCell>{host.lastHeartbeatAt ? formatRelative(host.lastHeartbeatAt) : 'Never'}</TableCell>
                      <TableCell>
                        {printers.length === 0 ? <span className="mj-secondary">None</span> : (
                          <span className="mj-inline">{printers.map((machine) => <CarbonLink key={machine.id} as={Link} to={`/machines/${machine.id}`}>{machine.name}</CarbonLink>)}</span>
                        )}
                      </TableCell>
                      <TableCell>{host.softwareVersion ?? '—'}</TableCell>
                      <TableCell>{host.pendingEventCount} pending · {host.quarantinedEventCount} quarantined</TableCell>
                      <TableCell className="cds--table-column-menu">
                        <OverflowMenu aria-label={`Actions for ${host.name}`} flipped size="sm">
                          <OverflowMenuItem itemText="Diagnostics" onClick={() => setDiagnostics(host)} />
                          {canCredentials && host.lifecycle === 'pending' && (
                            <OverflowMenuItem itemText="Enroll" disabled={enroll.pending} onClick={async () => { setSecret(await enroll.mutate(host.id)); }} />
                          )}
                          {canManage && (host.lifecycle === 'active' || host.lifecycle === 'disabled') && (
                            <OverflowMenuItem
                              itemText={host.lifecycle === 'disabled' ? 'Enable' : 'Disable'} disabled={setEnabled.pending}
                              onClick={async () => { const enable = host.lifecycle === 'disabled'; await setEnabled.mutate(host.id, enable); store.notify({ kind: 'success', title: enable ? 'Connector enabled' : 'Connector disabled', subtitle: host.name }); }}
                            />
                          )}
                          {canCredentials && host.lifecycle !== 'revoked' && <OverflowMenuItem itemText="Revoke" isDelete hasDivider onClick={() => setRevoking(host)} />}
                        </OverflowMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {store.connectorHosts.length === 0 && <EmptyState title="No connectors yet" description="Add a connector to collect runs automatically." action={canManage ? <Button kind="tertiary" onClick={() => setAdding(true)}>Add connector</Button> : undefined} />}
          </TableContainer>
        )}
      </DataTable>
      {adding && <AddConnectorModal onClose={() => setAdding(false)} onCreated={(value) => { setAdding(false); setSecret(value); }} />}
      {secret && <SecretModal secret={secret} onClose={() => setSecret(null)} />}
      {diagnostics && <DiagnosticsModal host={store.connectorHosts.find((item) => item.id === diagnostics.id) ?? diagnostics} printers={printersOf(diagnostics)} onClose={() => setDiagnostics(null)} />}
      <DestructiveActionDialog
        open={Boolean(revoking)} title={`Revoke ${revoking?.name ?? 'connector'}?`} confirmLabel="Revoke connector" pending={revoke.pending}
        onClose={() => setRevoking(null)}
        onConfirm={async () => { if (!revoking) return; await revoke.mutate(revoking.id); store.notify({ kind: 'success', title: 'Connector revoked', subtitle: revoking.name }); setRevoking(null); }}
      >
        <p>The connector can no longer deliver events, and this can't be undone.{revoking && printersOf(revoking).length > 0 ? ` ${printersOf(revoking).map((machine) => machine.name).join(', ')} will stop collecting runs automatically until reassigned.` : ''}</p>
      </DestructiveActionDialog>
    </div>
  );
}
