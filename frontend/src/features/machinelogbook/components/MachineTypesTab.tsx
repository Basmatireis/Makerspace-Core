import { useState, type ReactNode } from 'react';
import { Button, DataTable, InlineNotification, Modal, OverflowMenu, OverflowMenuItem, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, TableToolbar, TableToolbarContent, Tag, TextInput, Toggle } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MachineType } from '../../../api/generated/models';
import { createMachineType, updateMachineType } from '../../../api/generated/machines/machines';
import { EmptyState } from '../../../app/PageState';
import { machineLogbookKeys, machinesQuery, machineTypesQuery } from '../queries';
import { QueryBoundary } from '../shared/QueryBoundary';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';

const headers = [{ key: 'name', header: 'Name' }, { key: 'status', header: 'Status' }, { key: 'printer', header: 'Printer' }, { key: 'machines', header: 'Machines' }];

function TypeNameModal({ type, types, onClose }: { type?: MachineType; types: MachineType[]; onClose: () => void }) {
  const client = useQueryClient();
  const notify = useNotify();
  const [name, setName] = useState(type?.name ?? '');
  const [printer, setPrinter] = useState(type?.printer ?? false);
  const trimmed = name.trim();
  const taken = Boolean(trimmed) && types.some((item) => item.id !== type?.id && item.name.toLowerCase() === trimmed.toLowerCase());
  const unchanged = Boolean(type) && trimmed === type?.name && printer === type?.printer;
  const save = useMutation({
    mutationFn: () => type
      ? updateMachineType(type.id, { name: trimmed, printer, expectedVersion: type.version })
      : createMachineType({ name: trimmed, printer }),
    onSuccess: async (saved) => {
      notify({ kind: 'success', title: type ? 'Machine type saved' : 'Machine type added', subtitle: saved.name });
      onClose();
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
    },
  });
  const submit = () => { if (trimmed && !taken && !unchanged && !save.isPending) save.mutate(); };
  return (
    <Modal
      open size="xs" modalHeading={type ? 'Edit machine type' : 'Add machine type'} primaryButtonText={save.isPending ? 'Saving…' : type ? 'Save' : 'Add type'} secondaryButtonText="Cancel"
      primaryButtonDisabled={!trimmed || taken || unchanged || save.isPending} preventCloseOnClickOutside onRequestClose={() => { if (!save.isPending) onClose(); }} onRequestSubmit={submit}
    >
      <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <Stack gap={5}>
          <TextInput id="type-name" labelText="Name" value={name} autoComplete="off" data-modal-primary-focus invalid={taken} invalidText="This name is already used." onChange={(event) => setName(event.target.value)} />
          <Toggle id="type-printer" labelText="Printer" labelA="No" labelB="Yes" toggled={printer} onToggle={setPrinter} />
          <p className="mj-secondary">Machines of a printer type get a model, a connector and spool inputs when they are set up.</p>
          {save.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Machine type not saved" subtitle="Check that the name is unique. If someone else changed this type, close the dialog and reopen it." />}
        </Stack>
      </form>
    </Modal>
  );
}

export function MachineTypesTab({ switcher }: { switcher?: ReactNode }) {
  const can = useCan();
  const client = useQueryClient();
  const notify = useNotify();
  const canManage = can('machines.manage');
  const [dialog, setDialog] = useState<{ type?: MachineType } | null>(null);
  const types = useQuery(machineTypesQuery());
  const machines = useQuery(machinesQuery({ pageSize: 100 }));
  const items = types.data?.items ?? [];
  const count = (id: string) => (machines.data?.items ?? []).filter((machine) => machine.machineType.id === id).length;
  const patch = useMutation({
    mutationFn: ({ type, ...change }: { type: MachineType; active?: boolean; printer?: boolean }) => updateMachineType(type.id, { ...change, expectedVersion: type.version }),
    onSuccess: async (saved, change) => {
      notify({
        kind: 'success', subtitle: saved.name,
        title: change.printer !== undefined ? (saved.printer ? 'Marked as printer type' : 'No longer a printer type') : saved.active ? 'Machine type activated' : 'Machine type deactivated',
      });
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
    },
    onError: (_error, { type }) => notify({ kind: 'error', title: 'Machine type not saved', subtitle: `${type.name} may have changed. Reload the list and try again.` }),
  });

  return (
    <div className="mj-stack">
      <QueryBoundary query={types} errorMessage="The machine types could not be loaded.">
        <DataTable rows={items.map((type) => ({ id: type.id, name: type.name, status: type.active ? 'Active' : 'Inactive', printer: type.printer ? 'Printer' : '', machines: count(type.id) }))} headers={headers}>
          {({ rows, headers: tableHeaders, getRowProps, getTableProps }) => (
            <TableContainer className="mj-table-container">
              <TableToolbar aria-label="Machine types toolbar">
                {switcher}
                <TableToolbarContent>
                  {canManage && <Button kind="primary" size="lg" renderIcon={Add} onClick={() => setDialog({})}>Add type</Button>}
                </TableToolbarContent>
              </TableToolbar>
              <Table {...getTableProps()} aria-label="Machine types">
                <TableHead>
                  <TableRow>
                    {tableHeaders.map((header) => <TableHeader key={header.key}>{header.header}</TableHeader>)}
                    {canManage && <TableHeader aria-label="Actions" />}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((row) => {
                    const type = items.find((item) => item.id === row.id)!;
                    const { key, ...rowProps } = getRowProps({ row });
                    return (
                      <TableRow key={key} {...rowProps}>
                        <TableCell>{type.name}</TableCell>
                        <TableCell><Tag size="sm" type={type.active ? 'green' : 'gray'}>{type.active ? 'Active' : 'Inactive'}</Tag></TableCell>
                        <TableCell>
                          {canManage ? (
                            <Toggle
                              id={`type-printer-${type.id}`} size="sm" labelText={`${type.name} is a printer type`} hideLabel labelA="No" labelB="Yes" toggled={type.printer}
                              disabled={patch.isPending} onToggle={(printer) => patch.mutate({ type, printer })}
                            />
                          ) : (type.printer ? <Tag size="sm" type="blue">Printer</Tag> : <span className="mj-secondary">No</span>)}
                        </TableCell>
                        <TableCell>{machines.isSuccess ? count(type.id) : '—'}</TableCell>
                        {canManage && (
                          <TableCell className="cds--table-column-menu">
                            <OverflowMenu aria-label={`Actions for ${type.name}`} iconDescription={`Actions for ${type.name}`} flipped size="sm">
                              <OverflowMenuItem itemText="Edit" onClick={() => setDialog({ type })} />
                              <OverflowMenuItem itemText={type.active ? 'Deactivate' : 'Activate'} disabled={patch.isPending} onClick={() => patch.mutate({ type, active: !type.active })} />
                            </OverflowMenu>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {items.length === 0 && <EmptyState title="No machine types yet" description="Add a type to start adding machines." />}
            </TableContainer>
          )}
        </DataTable>
      </QueryBoundary>
      <p className="mj-secondary">Inactive types stay on existing machines but can't be chosen for new ones.</p>
      {dialog && <TypeNameModal key={dialog.type?.id ?? 'new'} type={dialog.type} types={items} onClose={() => setDialog(null)} />}
    </div>
  );
}
